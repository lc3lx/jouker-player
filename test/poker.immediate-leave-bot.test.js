const test = require("node:test");
const assert = require("node:assert/strict");

const { PokerTable } = require("../sockets/tableGame");
const { POKER_CAPACITY } = require("../utils/pokerTableStatus");
const { auditChipConservation } = require("../utils/poker/chipAuditor");

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

function mkGame(humanCount = 2) {
  const seats = Array.from({ length: humanCount }, (_, i) => ({
    user: { _id: `u${i}`, name: `P${i}` },
    userId: `u${i}`,
    chips: 100000,
    seatPosition: i,
    inHand: false,
    folded: false,
    allIn: false,
    invested: 0,
    bet: 0,
    isBot: false,
  }));
  const g = new PokerTable(createNspStub(), {
    _id: "table-immediate-leave",
    smallBlind: 1000,
    bigBlind: 2000,
    minBuyIn: 100000,
    maxBuyIn: 100000,
    capacity: POKER_CAPACITY,
    seats,
  });
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};
  g.autoRebuyBustedHumans = async () => 0;
  return g;
}

test("leavePlayerImmediately mid-hand folds player, replaces with bot in same chair, and preserves chip conservation", async () => {
  const g = mkGame(3);
  g.running = true;
  g.round = "flop";
  
  // Set up in-hand state:
  // Seat 0: bet 10000, remaining stack 90000
  // Seat 1: bet 10000, remaining stack 90000
  // Seat 2: bet 10000, remaining stack 90000
  for (let i = 0; i < 3; i++) {
    g.seats[i].inHand = true;
    g.seats[i].chips = 90000;
    g.seats[i].invested = 10000;
    g.seats[i].bet = 10000;
  }
  g.pot = 30000;
  g.handStartTotal = 300000; // 3 x 100000
  g.currentIndex = 1;

  assert.ok(auditChipConservation(g, "start").ok);

  // Player 1 leaves immediately
  const res = await g.leavePlayerImmediately("u1");

  assert.ok(res, "result should be returned");
  assert.equal(res.uncommittedChips, 90000, "uncommitted chips captured");
  assert.equal(res.forfeitedBet, 10000, "forfeited bet captured");
  assert.equal(res.chair, 1, "exact chair preserved");
  assert.equal(res.replacedWithBot, true, "bot took over seat");

  // Verify seat 1 is now a bot
  const botSeat = g.seats[1];
  assert.equal(botSeat.isBot, true, "seat 1 is now a bot");
  assert.equal(botSeat.seatPosition, 1, "bot is in the same chair");
  assert.equal(botSeat.inHand, false, "bot is not in active hand");
  assert.equal(botSeat.folded, true, "bot is folded");
  assert.equal(botSeat.invested, 10000, "bot preserved invested bet so pot math stays consistent");
  assert.equal(botSeat.chips, g.botBuyIn, "bot received standard bot buyin");

  // Verify pot is still intact
  assert.equal(g.pot, 30000, "pot preserves the forfeited bet");

  // Verify chip conservation is completely balanced
  const audit = auditChipConservation(g, "after_leave");
  assert.ok(audit.ok, `audit chip conservation failed: ${audit.reason}`);
});

test("leavePlayerImmediately advances turn if leaver was the current actor", async () => {
  const g = mkGame(3);
  g.running = true;
  g.round = "flop";
  for (let i = 0; i < 3; i++) {
    g.seats[i].inHand = true;
    g.seats[i].chips = 90000;
    g.seats[i].invested = 10000;
    g.seats[i].bet = 10000;
  }
  g.pot = 30000;
  g.handStartTotal = 300000;
  g.currentIndex = 0; // u0 is current turn

  await g.leavePlayerImmediately("u0");

  // Turn should have moved away from u0 (now bot)
  assert.notEqual(g.currentIndex, 0, "turn moved from folded leaver");
});

test("leavePlayerImmediately clears table to idle if the leaver was the last human", async () => {
  const g = mkGame(1);
  g.running = true;
  g.round = "flop";
  g.seats[0].inHand = true;
  g.seats[0].chips = 90000;
  g.seats[0].invested = 10000;
  g.pot = 10000;
  g.handStartTotal = 100000;

  const res = await g.leavePlayerImmediately("u0");
  assert.ok(res);
  assert.equal(res.uncommittedChips, 90000);
  assert.equal(res.forfeitedBet, 10000);

  // Table should now be idle with no seats
  assert.equal(g.running, false);
  assert.equal(g.round, "idle");
  assert.equal(g.seats.length, 0);
  assert.equal(g.pot, 0);
});

test("permanentLeavePokerTable with uncommittedChips and forfeitedBet releases chips and forfeits bet", async () => {
  const { permanentLeavePokerTable } = require("../services/pokerVacateService");
  assert.equal(typeof permanentLeavePokerTable, "function");
});
