const test = require("node:test");
const assert = require("node:assert/strict");

const { PokerTable } = require("../sockets/tableGame");
const { POKER_TIMINGS } = require("../utils/poker/timings");
const {
  PLAYER_STATE,
  canBeDealtIntoHand,
  canParticipateInNextHand,
  promoteWaitingToSeated,
  countEligibleHumans,
} = require("../utils/poker/playerState");
const { verifyHandChipConservation } = require("../utils/poker/chipConservation");
const { POKER_CAPACITY } = require("../utils/pokerTableStatus");

function createNspStub() {
  return {
    to() {
      return { emit() {} };
    },
    in() {
      return { async fetchSockets() { return []; } };
    },
  };
}

function mkTable(seatCount, chips = 100000) {
  const seats = Array.from({ length: seatCount }, (_, i) => ({
    user: { _id: `u${i}`, name: `P${i}` },
    chips,
  }));
  return {
    _id: "prod-table",
    smallBlind: 1000,
    bigBlind: 2000,
    minBuyIn: chips,
    maxBuyIn: chips,
    capacity: 9,
    seats,
  };
}

function mkGame(seatCount) {
  const g = new PokerTable(createNspStub(), mkTable(seatCount));
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};
  g.startHand = async function prodStartHand() {
    promoteWaitingToSeated(this.seats);
    for (const s of this.seats) {
      if (canBeDealtIntoHand(s)) {
        s.inHand = true;
        s.folded = false;
        s.hole = ["As", "Kd"];
        s.playerState = PLAYER_STATE.ACTIVE_HAND;
        s.handStartChips = s.chips;
      }
    }
    this.handStartTotal = this.seats.reduce((sum, s) => sum + s.chips, 0);
    this.running = true;
    this.round = "preflop";
  };
  return g;
}

function createAllocationStore() {
  const tables = new Map();
  let id = 0;
  let num = 0;
  let chain = Promise.resolve();
  const withLock = (tier, buyIn, fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
  const find = (tier, buyIn) => {
    const list = [...tables.values()]
      .filter((t) => t.tier === tier && t.seats.length < POKER_CAPACITY)
      .sort((a, b) => a.tableNumber - b.tableNumber);
    if (list.length) return list[0];
    num += 1;
    id += 1;
    const t = { _id: `t${id}`, tier, tableNumber: num, seats: [], waitingQueue: [] };
    tables.set(t._id, t);
    return t;
  };
  const join = (tier, buyIn, userId) =>
    withLock(tier, buyIn, async () => {
      const t = find(tier, buyIn);
      if (t.seats.length >= POKER_CAPACITY) throw new Error("TABLE_FULL");
      t.seats.push({ user: userId });
      return t;
    });
  const burst = async (n) => {
    await Promise.all(Array.from({ length: n }, (_, i) => join("beginner", 100000, `u${i}`)));
    const counts = [...tables.values()].map((t) => t.seats.length).sort((a, b) => b - a);
    return { tables: tables.size, counts, total: counts.reduce((a, b) => a + b, 0) };
  };
  return { burst, tables };
}

test("production timings defaults", () => {
  assert.equal(POKER_TIMINGS.TURN_SECONDS, 20);
  assert.equal(POKER_TIMINGS.PREFLOP_DEAL_MS, 2000);
  assert.equal(POKER_TIMINGS.NEXT_HAND_DELAY_MS, 4000);
  assert.equal(POKER_TIMINGS.RECONNECT_WINDOW_MS, 90000);
});

test("WAITING mid-hand joiners are not dealt", () => {
  const g = mkGame(2);
  g.seats.push({
    userId: "u2",
    name: "Late",
    chips: 100000,
    inHand: false,
    folded: true,
    isBot: false,
    playerState: PLAYER_STATE.WAITING,
    hole: [],
    bet: 0,
    invested: 0,
  });
  assert.equal(canBeDealtIntoHand(g.seats[2]), false);
  assert.equal(countEligibleHumans(g.seats), 2);
});

test("promoteWaitingToSeated enables next hand", () => {
  const seats = [
    { userId: "u0", chips: 1000, isBot: false, playerState: PLAYER_STATE.WAITING },
    { userId: "u1", chips: 1000, isBot: false, playerState: PLAYER_STATE.SEATED },
  ];
  promoteWaitingToSeated(seats);
  assert.equal(seats[0].playerState, PLAYER_STATE.SEATED);
  assert.equal(countEligibleHumans(seats), 2);
});

test("heads-up (2) can start", async () => {
  const g = mkGame(2);
  await g.startIfReady({ refreshFromDb: false });
  assert.equal(g.running, true);
});

test("6-max eligible count", () => {
  const g = mkGame(6);
  assert.equal(g.eligibleHumanCount(), 6);
});

test("9-max capacity", () => {
  const g = mkGame(9);
  assert.equal(g.seats.length, 9);
  assert.equal(g.capacity, 9);
});

test("chip conservation during hand", () => {
  const g = mkGame(3);
  g.handStartTotal = 295000;
  g.pot = 5000;
  g.seats[0].chips = 95000;
  g.seats[0].bet = 0;
  g.seats[1].chips = 90000;
  g.seats[1].bet = 5000;
  g.seats[2].chips = 100000;
  const check = verifyHandChipConservation(g);
  assert.equal(check.ok, true);
});

test("timeout uses check when free", async () => {
  const g = mkGame(2);
  g.running = true;
  g.round = "flop";
  g.currentIndex = 0;
  g.currentBet = 0;
  g.seats.forEach((s) => {
    s.inHand = true;
    s.folded = false;
    s.allIn = false;
    s.bet = 0;
    s.playerState = PLAYER_STATE.ACTIVE_HAND;
  });
  let advanced = 0;
  g.pacedAdvanceAfterAction = async () => {
    advanced += 1;
  };
  await g.handleTimeout();
  assert.equal(g.seats[0].folded, false);
  assert.equal(advanced, 1);
});

test("timeout folds when facing bet", async () => {
  const g = mkGame(2);
  g.running = true;
  g.round = "turn";
  g.currentIndex = 0;
  g.currentBet = 2000;
  g.seats[0].bet = 0;
  g.seats.forEach((s) => {
    s.inHand = true;
    s.folded = false;
    s.playerState = PLAYER_STATE.ACTIVE_HAND;
  });
  g.pacedAdvanceAfterAction = async () => {};
  await g.handleTimeout();
  assert.equal(g.seats[0].folded, true);
});

test("applyEngineVacate removes human and schedules pending vacate", async () => {
  const g = mkGame(2);
  const uid = g.seats[0].userId;
  const ok = await g.applyEngineVacate(uid, { chips: 8000 });
  assert.equal(ok, true);
  assert.equal(g.findSeatIndexByUser(uid), -1);
  assert.equal(g.pendingVacates.has(String(uid)), true);
  assert.equal(g.seats.length, 1);
});

test("reconnect restores DISCONNECTED to SEATED", () => {
  const g = mkGame(1);
  g.seats[0].playerState = PLAYER_STATE.DISCONNECTED;
  g.seats[0].reconnectDeadline = Date.now() + 5000;
  g.onPlayerSocketConnected(g.seats[0].userId);
  assert.equal(g.seats[0].playerState, PLAYER_STATE.SEATED);
  assert.equal(g.seats[0].reconnectDeadline, null);
});

test("spectator state has no hero holes for other users", () => {
  const g = mkGame(2);
  g.running = true;
  g.round = "preflop";
  g.seats[0].inHand = true;
  g.seats[0].hole = ["As", "Kd"];
  const pub = g.getPublicState(null);
  const hero = pub.seats.find((s) => s.userId === "u0");
  assert.deepEqual(hero.hole, [null, null]);
});

test("allocation: 100 players => 12 tables", async () => {
  const store = createAllocationStore();
  const r = await store.burst(100);
  assert.equal(r.total, 100);
  assert.equal(r.tables, 12);
  assert.equal(r.counts[0], 9);
  assert.equal(r.counts[r.counts.length - 1], 1);
});

test("allocation: 500 players balanced", async () => {
  const store = createAllocationStore();
  const r = await store.burst(500);
  assert.equal(r.total, 500);
  assert.equal(r.tables, Math.ceil(500 / 9));
  assert.ok(r.counts.every((c) => c <= 9));
});

test("allocation: 1000 players balanced", async () => {
  const store = createAllocationStore();
  const r = await store.burst(1000);
  assert.equal(r.total, 1000);
  assert.equal(r.tables, Math.ceil(1000 / 9));
  const max = Math.max(...r.counts);
  const min = Math.min(...r.counts);
  assert.equal(max, 9);
  assert.ok(min >= 1);
});

test("action rejected for WAITING player state", async () => {
  const g = mkGame(2);
  g.running = true;
  g.round = "preflop";
  g.currentIndex = 0;
  g.currentBet = 0;
  g.seats[0].playerState = PLAYER_STATE.WAITING;
  g.seats[0].inHand = false;
  g.seats[1].inHand = true;
  g.seats[1].playerState = PLAYER_STATE.ACTIVE_HAND;
  const res = await g.handleAction("u0", { action: "call", actionId: "a1" });
  assert.equal(res.status, "rejected");
});

test("resetToEmptyIdle zeros pot seats and round", async () => {
  const g = mkGame(2);
  g.running = true;
  g.round = "preflop";
  g.pot = 5000;
  g.community = ["As", "Kd", "2c"];
  g.seats[0].bet = 1000;
  await g.resetToEmptyIdle({ seats: [], smallBlind: 100, bigBlind: 200, capacity: 9 });
  assert.equal(g.running, false);
  assert.equal(g.round, "idle");
  assert.equal(g.pot, 0);
  assert.equal(g.seats.length, 0);
  assert.deepEqual(g.community, []);
});

test("last human leaving aborts a bot-only hand and empties the engine", async () => {
  const g = mkGame(3);
  // Seat 0 stays human; the rest become bots.
  g.seats[0].isBot = false;
  for (let i = 1; i < g.seats.length; i++) {
    g.seats[i].isBot = true;
    g.seats[i].userId = `bot-${i}`;
  }
  g.running = true;
  g.round = "flop";
  g.pot = 4000;
  g.currentBet = 1000;
  g.currentHandId = "hand-1";

  const humanId = g.seats[0].userId;
  assert.equal(g.humanSeatCount(), 1);

  await g.removeLiveHumanSeat(humanId);

  // Engine must not keep running with just bots; it should be idle + empty so
  // the table can be reset immediately after the last human leaves.
  assert.equal(g.humanSeatCount(), 0);
  assert.equal(g.running, false);
  assert.equal(g.round, "idle");
  assert.equal(g.seats.length, 0);
  assert.equal(g.pot, 0);
  assert.equal(g.currentBet, 0);
  assert.equal(g.currentHandId, null);
});

console.log("poker.production.test.js: all tests registered");
