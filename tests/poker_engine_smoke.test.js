/* eslint-disable no-console */
const assert = require("assert");

const { PokerTable } = require("../sockets/tableGame");
const { bestOf7, compareHands7 } = require("../utils/poker/handEval");

function createNspStub() {
  return {
    to() {
      return { emit() {} };
    },
    in() {
      return {
        async fetchSockets() {
          return [];
        },
      };
    },
  };
}

function createTableWithSeats() {
  return {
    _id: "table-test",
    smallBlind: 50,
    bigBlind: 100,
    minBuyIn: 1000,
    maxBuyIn: 10000,
    capacity: 9,
    seats: [
      { user: { _id: "u1", name: "P1" }, chips: 3000 },
      { user: { _id: "u2", name: "P2" }, chips: 3000 },
      { user: { _id: "u3", name: "P3" }, chips: 3000 },
    ],
  };
}

function testRaiseRuleTracksLastRaiseAmount() {
  const g = new PokerTable(createNspStub(), createTableWithSeats());
  g.running = true;
  g.round = "preflop";

  // Set up an active hand shell.
  g.seats.forEach((s) => {
    s.inHand = true;
    s.folded = false;
    s.allIn = false;
    s.bet = 0;
    s.invested = 0;
  });
  g.currentBet = 100;
  g.lastRaiseAmount = 100;
  g.minRaise = 100;

  // Seat 0 raises by +250 over call.
  g.applyBetOrRaise(0, 250);
  assert.strictEqual(g.lastRaiseAmount, 250);
  assert.strictEqual(g.minRaise, 250);

  const spec = g.computeTurnActionSpec(1);
  assert.strictEqual(spec.minRaise, 250);
}

function testShortAllInDoesNotUpdateLastRaiseAmount() {
  const g = new PokerTable(createNspStub(), createTableWithSeats());
  g.running = true;
  g.round = "preflop";
  g.seats.forEach((s) => {
    s.inHand = true;
    s.folded = false;
    s.allIn = false;
    s.bet = 0;
    s.invested = 0;
  });

  g.currentBet = 500;
  g.lastRaiseAmount = 200;
  g.minRaise = 200;

  // Player can only add +100 above call due to short stack (all-in short raise).
  g.seats[0].chips = 600; // need=500, amount=200 => toPut=700 but pays 600 => diff=100 short
  g.applyBetOrRaise(0, 200);

  assert.strictEqual(g.currentBet, 600);
  assert.strictEqual(g.lastRaiseAmount, 200);
  assert.strictEqual(g.minRaise, 200);
}

function testSidePotsMultipleAllIns() {
  const g = new PokerTable(createNspStub(), createTableWithSeats());
  g.dealerIndex = 0;

  // Contributions:
  // p1 = 100, p2 = 200, p3 = 500
  // Pots:
  // main: 300 eligible p1,p2,p3
  // side1: 200 eligible p2,p3
  // side2: 300 eligible p3
  g.seats[0].inHand = true;
  g.seats[1].inHand = true;
  g.seats[2].inHand = true;
  g.seats[0].folded = false;
  g.seats[1].folded = false;
  g.seats[2].folded = false;
  g.seats[0].invested = 100;
  g.seats[1].invested = 200;
  g.seats[2].invested = 500;

  const rankByIndex = new Map();
  // p1 best, p2 middle, p3 weakest
  rankByIndex.set(0, { cat: 4, tiebreak: [14] });
  rankByIndex.set(1, { cat: 3, tiebreak: [13] });
  rankByIndex.set(2, { cat: 2, tiebreak: [12] });

  const { payouts, potDistribution } = g.resolveSidePotPayoutsWithDistribution(rankByIndex);
  assert.strictEqual(payouts.get(0), 300);
  assert.strictEqual(payouts.get(1), 200);
  assert.strictEqual(payouts.get(2), 300);
  assert.strictEqual(potDistribution.length, 3);
}

async function testTimeoutCheckVsFold() {
  const g = new PokerTable(createNspStub(), createTableWithSeats());
  g.running = true;
  g.round = "flop";
  g.currentIndex = 0;
  g.seats.forEach((s) => {
    s.inHand = true;
    s.folded = false;
    s.allIn = false;
    s.bet = 0;
  });

  let advanced = 0;
  g.advance = async () => {
    advanced += 1;
  };

  // Check path
  g.currentBet = 0;
  await g.handleTimeout();
  assert.strictEqual(advanced, 1);
  assert.strictEqual(g.seats[0].folded, false);

  // Fold path
  g.currentBet = 100;
  g.seats[0].bet = 0;
  await g.handleTimeout();
  assert.strictEqual(advanced, 2);
  assert.strictEqual(g.seats[0].folded, true);
}

function testHandEvalTieSplitCorrectness() {
  // Board gives everyone same straight
  const board = ["Ah", "Kd", "Qc", "Jh", "Ts"];
  const p1 = ["2c", "3d"];
  const p2 = ["4c", "5d"];
  const cmp = compareHands7([...p1, ...board], [...p2, ...board]);
  assert.strictEqual(cmp, 0);

  const best = bestOf7([...p1, ...board]);
  assert.strictEqual(best.cat, 4); // straight
}

/** Mirrors showdown() reveal step filtering — skipped seats must not skew step/total. */
function testShowdownRevealFiltersIncompleteHoles() {
  const revealOrder = [0, 1, 2];
  const seats = [{ hole: ["As", "Kd"] }, { hole: ["2c"] }, { hole: ["3h", "4h"] }];
  const revealSteps = [];
  for (const seatIndex of revealOrder) {
    const s = seats[seatIndex];
    if (!s || !Array.isArray(s.hole) || s.hole.length < 2) continue;
    revealSteps.push({ seatIndex, s });
  }
  assert.strictEqual(revealSteps.length, 2);
  assert.strictEqual(revealSteps[0].seatIndex, 0);
  assert.strictEqual(revealSteps[1].seatIndex, 2);
}

async function testDuplicateActionIdRejected() {
  const g = new PokerTable(createNspStub(), createTableWithSeats());
  g.running = true;
  g.round = "preflop";
  g.currentIndex = 0;
  g.currentBet = 0;
  g.lastRaiseAmount = 100;
  g.minRaise = 100;
  g.currentHandId = "h-test";
  g.currentHandActions = [];
  g.processedActionIds = new Set();

  g.seats.forEach((s, i) => {
    s.inHand = true;
    s.folded = false;
    s.allIn = false;
    s.bet = 0;
    s.invested = 0;
    s.userId = `u${i + 1}`;
  });

  g.advance = async () => {};

  const first = await g.handleAction("u1", {
    action: "call",
    actionId: "act-1",
  });
  assert.strictEqual(first.status, "accepted");

  const second = await g.handleAction("u1", {
    action: "call",
    actionId: "act-1",
  });
  assert.strictEqual(second.status, "rejected");
  assert.strictEqual(second.reason, "DUPLICATE_ACTION");
}

async function run() {
  testRaiseRuleTracksLastRaiseAmount();
  testShortAllInDoesNotUpdateLastRaiseAmount();
  testSidePotsMultipleAllIns();
  await testTimeoutCheckVsFold();
  testHandEvalTieSplitCorrectness();
  await testDuplicateActionIdRejected();
  testShowdownRevealFiltersIncompleteHoles();
  console.log("poker_engine_smoke.test.js passed");
}

run();

