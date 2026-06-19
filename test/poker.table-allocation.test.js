const test = require("node:test");
const assert = require("node:assert/strict");

const { PokerTable } = require("../sockets/tableGame");
const {
  POKER_CAPACITY,
  POKER_MIN_PLAYERS,
  derivePokerTableStatus,
  buildPokerLobbyFields,
  normalizeCapacity,
} = require("../utils/pokerTableStatus");

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

function mkMongoTable(seatCount, overrides = {}) {
  const seats = Array.from({ length: seatCount }, (_, i) => ({
    user: { _id: `u${i}`, name: `P${i}` },
    chips: 100000,
  }));
  return {
    _id: overrides._id || "table-1",
    smallBlind: 1000,
    bigBlind: 2000,
    minBuyIn: 100000,
    maxBuyIn: 100000,
    capacity: 9,
    seats,
    ...overrides,
  };
}

function mkGame(seatCount, overrides = {}) {
  const g = new PokerTable(createNspStub(), mkMongoTable(seatCount, overrides));
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};
  g.startHand = async () => {
    g.handStarted = true;
  };
  return g;
}

/** In-memory poker table store for allocation simulation. */
function createPokerAllocationStore() {
  const tables = new Map();
  let idSeq = 0;
  let tableNumSeq = 0;
  let chain = Promise.resolve();

  const withLock = (tier, buyIn, fn) => {
    const key = `${tier}:${buyIn}`;
    const prev = chain;
    let resolve;
    chain = new Promise((r) => {
      resolve = r;
    });
    return prev.then(fn).finally(resolve);
  };

  const findAvailable = (tier, buyIn) => {
    const list = [...tables.values()]
      .filter(
        (t) =>
          t.tier === tier &&
          t.minBuyIn === buyIn &&
          t.maxBuyIn === buyIn &&
          t.status !== "full" &&
          t.status !== "closed" &&
          t.seats.length < POKER_CAPACITY
      )
      .sort((a, b) => a.tableNumber - b.tableNumber);
    if (list.length) return list[0];

    tableNumSeq += 1;
    idSeq += 1;
    const t = {
      _id: `dyn_${idSeq}`,
      gameType: "poker",
      tier,
      tableNumber: tableNumSeq,
      minBuyIn: buyIn,
      maxBuyIn: buyIn,
      capacity: POKER_CAPACITY,
      seats: [],
      status: "waiting",
    };
    tables.set(t._id, t);
    return t;
  };

  const joinSeat = (tableId, userId) => {
    const t = tables.get(tableId);
    if (!t) throw new Error("TABLE_NOT_FOUND");
    if (t.seats.length >= POKER_CAPACITY) throw new Error("TABLE_FULL");
    if (t.seats.find((s) => s.user === userId)) throw new Error("ALREADY_SEATED");
    t.seats.push({ user: userId, chips: t.minBuyIn });
    t.status = derivePokerTableStatus({
      mongoSeatCount: t.seats.length,
      capacity: t.capacity,
      running: false,
      round: "idle",
    });
    return t;
  };

  const allocateJoin = async (tier, buyIn, userId) => {
    return withLock(tier, buyIn, async () => {
      let lastErr = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const table = findAvailable(tier, buyIn);
          return joinSeat(table._id, userId);
        } catch (e) {
          lastErr = e;
          if (e.message !== "TABLE_FULL") throw e;
        }
      }
      throw lastErr || new Error("TABLE_FULL");
    });
  };

  const joinConcurrent = async (n, tier, buyIn) => {
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => allocateJoin(tier, buyIn, `user_${i}`))
    );
    return results;
  };

  return {
    tables,
    findAvailable,
    joinSeat,
    allocateJoin,
    joinConcurrent,
    distribution() {
      const counts = [...tables.values()].map((t) => t.seats.length).sort((a, b) => b - a);
      return { tableCount: tables.size, seatCounts: counts };
    },
  };
}

test("derivePokerTableStatus: 1/9 waiting, 2/9 ready, 9/9 full", () => {
  assert.equal(
    derivePokerTableStatus({ mongoSeatCount: 1, capacity: 9, running: false, round: "idle" }),
    "waiting"
  );
  assert.equal(
    derivePokerTableStatus({ mongoSeatCount: 2, capacity: 9, running: false, round: "idle" }),
    "ready"
  );
  assert.equal(
    derivePokerTableStatus({ mongoSeatCount: 9, capacity: 9, running: false, round: "idle" }),
    "full"
  );
  assert.equal(
    derivePokerTableStatus({ mongoSeatCount: 3, capacity: 9, running: true, round: "preflop" }),
    "playing"
  );
});

test("buildPokerLobbyFields exposes seatedCount and playersNeeded", () => {
  const w = buildPokerLobbyFields({ mongoSeatCount: 1, capacity: 9, running: false, round: "idle" });
  assert.equal(w.seatedCount, 1);
  assert.equal(w.playersNeeded, 1);
  assert.equal(w.tableStatus, "waiting");
  assert.equal(w.canStart, false);

  const r = buildPokerLobbyFields({ mongoSeatCount: 2, capacity: 9, running: false, round: "idle" });
  assert.equal(r.playersNeeded, 0);
  assert.equal(r.tableStatus, "ready");
  assert.equal(r.canStart, true);
});

test("normalizeCapacity hard caps at 9", () => {
  assert.equal(normalizeCapacity(10), 9);
  assert.equal(normalizeCapacity(9), 9);
});

test("1 seated human does not start a hand", async () => {
  const g = mkGame(1);
  await g.startIfReady({ refreshFromDb: false });
  assert.equal(g.running, false);
  assert.equal(g.handStarted, undefined);
  const lobby = g.buildLobbyStateFields();
  assert.equal(lobby.seatedCount, 1);
  assert.equal(lobby.playersNeeded, 1);
  assert.equal(lobby.tableStatus, "waiting");
});

test("2 seated humans start a hand", async () => {
  const g = mkGame(2);
  await g.startIfReady({ refreshFromDb: false });
  assert.equal(g.running, true);
  assert.equal(g.handStarted, true);
});

test("engine rejects more than 9 seats from mongo", () => {
  const g = mkGame(12);
  assert.equal(g.seats.length, 9);
  assert.equal(g.capacity, 9);
});

test("in-memory store rejects 10th seat on same table", () => {
  const store = createPokerAllocationStore();
  const t = store.findAvailable("beginner", 100000);
  for (let i = 0; i < 9; i += 1) {
    store.joinSeat(t._id, `u${i}`);
  }
  assert.throws(() => store.joinSeat(t._id, "u10"), /TABLE_FULL/);
  assert.equal(t.status, "full");
});

test("20 players distribute across 3 tables (9+9+2)", async () => {
  const store = createPokerAllocationStore();
  await store.joinConcurrent(20, "beginner", 100000);
  const d = store.distribution();
  assert.equal(d.tableCount, 3);
  assert.deepEqual(d.seatCounts, [9, 9, 2]);
});

test("100 players distribute across 12 tables (11x9 + 1)", async () => {
  const store = createPokerAllocationStore();
  await store.joinConcurrent(100, "beginner", 100000);
  const d = store.distribution();
  assert.equal(d.tableCount, 12);
  assert.equal(d.seatCounts.reduce((a, b) => a + b, 0), 100);
  assert.equal(d.seatCounts[0], 9);
  assert.equal(d.seatCounts[d.seatCounts.length - 1], 1);
  assert.ok(d.seatCounts.every((c) => c <= 9));
});

test("concurrent joins never exceed 9 seats per table", async () => {
  const store = createPokerAllocationStore();
  await store.joinConcurrent(50, "intermediate", 200000);
  for (const t of store.tables.values()) {
    assert.ok(t.seats.length <= POKER_CAPACITY, `table ${t._id} over capacity`);
  }
});

test("getPublicState includes lobby fields for reconnect while waiting", () => {
  const g = mkGame(1);
  const state = g.getPublicState("u0");
  assert.equal(state.seatedCount, 1);
  assert.equal(state.playersNeeded, 1);
  assert.equal(state.tableStatus, "waiting");
  assert.equal(state.capacity, 9);
});

test("getPublicState includes playing status during active hand", () => {
  const g = mkGame(3);
  g.running = true;
  g.round = "flop";
  const state = g.getPublicState(null);
  assert.equal(state.tableStatus, "playing");
  assert.equal(state.seatedCount, 3);
});

test("start-if-ready with 1 human does not invoke startHand even via socket path", async () => {
  const g = mkGame(1);
  let starts = 0;
  g.startHand = async () => {
    starts += 1;
  };
  await g.startIfReady({ refreshFromDb: false });
  assert.equal(starts, 0);
  assert.equal(g.buildLobbyStateFields().playersNeeded, POKER_MIN_PLAYERS - 1);
});

console.log("poker.table-allocation.test.js: all tests registered");
