/**
 * Poker production-readiness regression suite (Phase 2 sprint).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { PokerTable } = require("../sockets/tableGame");
const { deriveMinimumBet } = require("../utils/poker/tableBettingConfig");
const { auditChipConservation } = require("../utils/poker/chipAuditor");

function createNspStub() {
  const emitted = [];
  return {
    emitted,
    to() {
      return { emit(event, payload) { emitted.push({ event, payload }); } };
    },
    in() {
      return { async fetchSockets() { return []; } };
    },
  };
}

function mkTableDoc(overrides = {}) {
  const buyIn = overrides.buyIn ?? overrides.minBuyIn ?? 100000;
  return {
    _id: overrides._id || "ready-table",
    smallBlind: overrides.smallBlind ?? 500,
    bigBlind: overrides.bigBlind ?? 1000,
    minBuyIn: buyIn,
    maxBuyIn: buyIn,
    buyIn,
    minimumBet: overrides.minimumBet ?? deriveMinimumBet(buyIn),
    capacity: 9,
    seats: overrides.seats ?? [
      { user: { _id: "u1", name: "P1" }, chips: buyIn },
      { user: { _id: "u2", name: "P2" }, chips: buyIn },
      { user: { _id: "u3", name: "P3" }, chips: buyIn },
    ],
  };
}

function mkGame(overrides = {}) {
  const g = new PokerTable(createNspStub(), mkTableDoc(overrides));
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};
  return g;
}

function seatSetup(g, count = 3) {
  for (let i = 0; i < count; i++) {
    const s = g.seats[i];
    s.inHand = true;
    s.folded = false;
    s.allIn = false;
    s.bet = 0;
    s.invested = 0;
    s.actedThisStreet = false;
    s.chips = g.buyIn;
  }
}

test("deriveMinimumBet defaults to buyIn / 10", () => {
  assert.equal(deriveMinimumBet(100000), 10000);
  assert.equal(deriveMinimumBet(10000), 1000);
  assert.equal(deriveMinimumBet(1000000), 100000);
  assert.equal(deriveMinimumBet(50000, 7500), 7500);
});

test("everyoneSettled requires actedThisStreet — BB option after limp", () => {
  const g = mkGame();
  g.running = true;
  g.round = "preflop";
  g.currentBet = 1000;
  seatSetup(g, 3);
  g.seats[0].bet = 1000;
  g.seats[0].actedThisStreet = true;
  g.seats[1].bet = 1000;
  g.seats[1].actedThisStreet = true;
  g.seats[2].bet = 1000;
  g.seats[2].actedThisStreet = false;
  assert.equal(g.everyoneSettled(), false);
  g.seats[2].actedThisStreet = true;
  assert.equal(g.everyoneSettled(), true);
});

test("everyoneSettled — heads-up SB call leaves BB option", () => {
  const g = mkGame({ seats: mkTableDoc().seats.slice(0, 2) });
  g.running = true;
  g.round = "preflop";
  g.currentBet = 1000;
  seatSetup(g, 2);
  g.seats[0].bet = 1000;
  g.seats[0].actedThisStreet = true;
  g.seats[1].bet = 1000;
  g.seats[1].actedThisStreet = false;
  assert.equal(g.everyoneSettled(), false);
});

test("everyoneSettled — all-in player counts as settled", () => {
  const g = mkGame();
  g.running = true;
  g.currentBet = 5000;
  seatSetup(g, 2);
  g.seats[0].bet = 5000;
  g.seats[0].allIn = true;
  g.seats[0].actedThisStreet = false;
  g.seats[1].bet = 5000;
  g.seats[1].actedThisStreet = true;
  assert.equal(g.everyoneSettled(), true);
});

test("computeTurnActionSpec exposes check when free", async () => {
  const g = mkGame();
  g.running = true;
  g.round = "flop";
  g.currentBet = 0;
  seatSetup(g, 1);
  g.seats[0].bet = 0;
  const spec = g.computeTurnActionSpec(0);
  assert.equal(spec.canCheck, true);
  assert.ok(spec.allowed.includes("check"));
  assert.ok(!spec.allowed.includes("call"));
});

test("handleAction accepts check action", async () => {
  const g = mkGame();
  g.running = true;
  g.round = "flop";
  g.currentIndex = 0;
  g.currentBet = 0;
  seatSetup(g, 1);
  g.seats[0].userId = "u1";
  let advanced = 0;
  g.pacedAdvanceAfterAction = async () => { advanced += 1; };

  const res = await g.handleAction("u1", {
    action: "check",
    actionId: "chk-1",
  });
  assert.equal(res.status, "accepted");
  assert.equal(advanced, 1);
  assert.equal(g.seats[0].actedThisStreet, true);
});

test("handleAction rejects fold disguised as check path when facing bet", async () => {
  const g = mkGame();
  g.running = true;
  g.round = "flop";
  g.currentIndex = 0;
  g.currentBet = 2000;
  seatSetup(g, 1);
  g.seats[0].userId = "u1";
  g.seats[0].bet = 0;

  const res = await g.handleAction("u1", {
    action: "check",
    actionId: "chk-bad",
  });
  assert.equal(res.status, "rejected");
});

test("auditChipConservation passes after postBlind (9-handed table baseline)", () => {
  const buyIn = 10000;
  const smallBlind = 100;
  const bigBlind = 200;
  const seats = Array.from({ length: 9 }, () => ({
    chips: buyIn,
    bet: 0,
    inHand: true,
  }));
  seats[0].chips -= smallBlind;
  seats[0].bet = smallBlind;
  seats[1].chips -= bigBlind;
  seats[1].bet = bigBlind;
  const pot = smallBlind + bigBlind;
  const handStartTotal = buyIn * 9;

  const r = auditChipConservation(
    { seats, pot, handStartTotal, uncollectedRake: 0 },
    "post_blinds"
  );
  assert.equal(r.ok, true, `delta=${r.delta} pot=${r.pot}`);
});

test("minimum bet enforced on opening raise", async () => {
  const g = mkGame({ buyIn: 100000, minimumBet: 10000 });
  g.running = true;
  g.round = "flop";
  g.currentIndex = 0;
  g.currentBet = 0;
  seatSetup(g, 1);
  g.seats[0].userId = "u1";
  g.seats[0].chips = 100000;

  const spec = g.computeTurnActionSpec(0);
  assert.ok(spec.minRaise >= 10000);

  const bad = await g.handleAction("u1", {
    action: "raise",
    amount: 1000,
    actionId: "raise-low",
  });
  assert.equal(bad.status, "rejected");

  const ok = await g.handleAction("u1", {
    action: "raise",
    amount: 10000,
    actionId: "raise-ok",
  });
  assert.equal(ok.status, "accepted");
});

test("resetHandBettingState clears pot and street bets after settlement", () => {
  const g = mkGame();
  g.pot = 25000;
  g.currentBet = 5000;
  g.seats[0].bet = 5000;
  g.seats[0].invested = 25000;
  g.resetHandBettingState();
  assert.equal(g.pot, 0);
  assert.equal(g.currentBet, 0);
  assert.equal(g.seats[0].bet, 0);
  assert.equal(g.seats[0].invested, 0);
});

test("jackpot disabled by default does not deduct chips", async () => {
  const prev = process.env.JACKPOT_ENABLED;
  delete process.env.JACKPOT_ENABLED;
  const g = mkGame();
  seatSetup(g, 2);
  g.seats[0].inHand = true;
  g.seats[0].chips = 50000;
  const before = g.seats[0].chips;
  const deducted = await g.applyJackpotContribution();
  assert.equal(deducted, 0);
  assert.equal(g.seats[0].chips, before);
  if (prev != null) process.env.JACKPOT_ENABLED = prev;
});

test("jackpot enabled adjusts conservation baseline", async () => {
  const Jackpot = require("../models/jackpotModel");
  const prevEn = process.env.JACKPOT_ENABLED;
  const prevFee = process.env.JACKPOT_FEE_PER_HAND;
  const prevSingleton = Jackpot.getSingleton;
  process.env.JACKPOT_ENABLED = "true";
  process.env.JACKPOT_FEE_PER_HAND = "100";
  Jackpot.getSingleton = async () => ({
    contributionPerHand: 100,
    pot: 0,
    save: async () => {},
  });

  const g = mkGame({
    seats: [{ user: { _id: "u1", name: "P1" }, chips: 100000 }],
  });
  seatSetup(g, 1);
  g.seats[0].inHand = true;
  g.seats[0].isBot = false;
  g.seats[0].chips = 100000;
  g.handStartTotal = 100000;

  const deducted = await g.applyJackpotContribution();
  assert.equal(deducted, 100);
  g.handStartTotal -= deducted;
  const audit = auditChipConservation(g, "jackpot_test");
  assert.equal(audit.ok, true);

  Jackpot.getSingleton = prevSingleton;
  if (prevEn != null) process.env.JACKPOT_ENABLED = prevEn;
  else delete process.env.JACKPOT_ENABLED;
  if (prevFee != null) process.env.JACKPOT_FEE_PER_HAND = prevFee;
  else delete process.env.JACKPOT_FEE_PER_HAND;
});

test("broadcastState emits per seated socket without reconnect_state", async () => {
  const socketEvents = [];
  const sockets = [{
    userId: "u1",
    emit(event) {
      socketEvents.push(event);
    },
  }];
  const nsp = {
    emitted: [],
    to() {
      return { emit(event) { nsp.emitted.push(event); } };
    },
    in() {
      return { async fetchSockets() { return sockets; } };
    },
  };

  const g = new PokerTable(nsp, mkTableDoc({
    seats: [{ user: { _id: "u1", name: "P1" }, chips: 100000 }],
  }));
  g.seats[0].userId = "u1";
  g.saveSnapshot = async () => {};
  g.syncMongoTableStatus = async () => {};
  await g.broadcastState();

  assert.ok(socketEvents.includes("table_state"));
  assert.ok(socketEvents.includes("table_state_me"));
  assert.equal(socketEvents.filter((e) => e === "reconnect_state").length, 0);
});

test("duplicate actionId rejected — concurrency guard", async () => {
  const g = mkGame();
  g.running = true;
  g.round = "flop";
  g.currentIndex = 0;
  g.currentBet = 0;
  seatSetup(g, 1);
  g.seats[0].userId = "u1";
  g.pacedAdvanceAfterAction = async () => {};

  const first = await g.handleAction("u1", {
    action: "check",
    actionId: "dup-1",
  });
  assert.equal(first.status, "accepted");

  const second = await g.handleAction("u1", {
    action: "check",
    actionId: "dup-1",
  });
  assert.equal(second.status, "rejected");
  assert.equal(second.reason, "DUPLICATE_ACTION");
});

test("wallet settlement mock — winner gains loser loses", async () => {
  const ledger = new Map();
  const applyLockedDelta = async ({ userId, delta }) => {
    ledger.set(String(userId), (ledger.get(String(userId)) || 0) + delta);
  };

  const g = mkGame({ buyIn: 10000 });
  g.pot = 4000;
  g.handStartTotal = 20000;
  g.seats[0].handStartChips = 10000;
  g.seats[0].chips = 6000;
  g.seats[1].handStartChips = 10000;
  g.seats[1].chips = 6000;
  g.seats[0].isBot = false;
  g.seats[1].isBot = false;
  g.seats[0].userId = "human1";
  g.seats[1].userId = "human2";

  const payouts = new Map([[0, 4000]]);
  g.seats[0].chips += 4000;
  g.resetHandBettingState();

  await applyLockedDelta({ userId: "human1", delta: 2000 });
  await applyLockedDelta({ userId: "human2", delta: -2000 });

  assert.equal(ledger.get("human1"), 2000);
  assert.equal(ledger.get("human2"), -2000);
  assert.equal(ledger.get("human1") + ledger.get("human2"), 0);
  assert.equal(g.pot, 0);
});

test("getPublicState includes buyIn and minimumBet", () => {
  const g = mkGame({ buyIn: 100000, minimumBet: 10000 });
  const pub = g.getPublicState(null);
  assert.equal(pub.buyIn, 100000);
  assert.equal(pub.minimumBet, 10000);
});
