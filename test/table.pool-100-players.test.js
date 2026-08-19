/**
 * Simulates 100 concurrent joins at the same stake tier for Poker, Trix, and Tarneeb41.
 * Mirrors first-fit + dynamic table creation with per-stake locking (same as production).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { POKER_CAPACITY } = require("../utils/pokerTableStatus");

const DEBUG_LOG = path.join(__dirname, "..", "..", "debug-b181d7.log");
const SESSION_ID = "b181d7";

// #region agent log
function agentLog(message, data, hypothesisId = "H1") {
  const line = JSON.stringify({
    sessionId: SESSION_ID,
    runId: "pool-100",
    hypothesisId,
    location: "table.pool-100-players.test.js",
    message,
    data,
    timestamp: Date.now(),
  });
  try {
    fs.appendFileSync(DEBUG_LOG, `${line}\n`);
  } catch (_) {
    /* ignore in CI without workspace */
  }
}
// #endregion

/** Generic first-fit allocator with per tier+buyIn lock (matches pokerTableAllocationService). */
function createAllocationStore({ capacity, gameType }) {
  const tables = new Map();
  let idSeq = 0;
  let tableNumSeq = 0;
  const chains = new Map();

  const withLock = (tier, buyIn, fn) => {
    const key = `${gameType}:${tier}:${buyIn}`;
    const prev = chains.get(key) || Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(fn)
      .finally(() => {
        if (chains.get(key) === run) chains.delete(key);
      });
    chains.set(key, run);
    return run;
  };

  const findAvailable = (tier, buyIn) => {
    const list = [...tables.values()]
      .filter(
        (t) =>
          t.gameType === gameType &&
          t.tier === tier &&
          t.minBuyIn === buyIn &&
          t.maxBuyIn === buyIn &&
          t.seats.length < capacity
      )
      .sort((a, b) => a.tableNumber - b.tableNumber);
    if (list.length) return list[0];

    tableNumSeq += 1;
    idSeq += 1;
    const t = {
      _id: `${gameType}_dyn_${idSeq}`,
      gameType,
      tier,
      tableNumber: tableNumSeq,
      minBuyIn: buyIn,
      maxBuyIn: buyIn,
      capacity,
      seats: [],
    };
    tables.set(t._id, t);
    return t;
  };

  const joinSeat = (tableId, userId) => {
    const t = tables.get(tableId);
    if (!t) throw new Error("TABLE_NOT_FOUND");
    if (t.seats.length >= capacity) throw new Error("TABLE_FULL");
    if (t.seats.find((s) => s.user === userId)) throw new Error("ALREADY_SEATED");
    t.seats.push({ user: userId, chips: t.minBuyIn });
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
      Array.from({ length: n }, (_, i) => allocateJoin(tier, buyIn, `${gameType}_user_${i}`))
    );
    return results;
  };

  const distribution = () => {
    const seatCounts = [...tables.values()]
      .map((t) => t.seats.length)
      .sort((a, b) => b - a);
    const totalSeated = seatCounts.reduce((a, b) => a + b, 0);
    return {
      gameType,
      capacity,
      tableCount: tables.size,
      seatCounts,
      totalSeated,
      stakeSeatedCount: totalSeated,
      stakeTableCount: tables.size,
    };
  };

  return { tables, joinConcurrent, distribution };
}

function assertDistribution(d, playerCount, capacity) {
  const expectedTables = Math.ceil(playerCount / capacity);
  assert.equal(d.totalSeated, playerCount, `${d.gameType}: total seated`);
  assert.equal(d.tableCount, expectedTables, `${d.gameType}: table count`);
  assert.equal(d.stakeSeatedCount, playerCount, `${d.gameType}: stakeSeatedCount`);
  assert.equal(d.stakeTableCount, expectedTables, `${d.gameType}: stakeTableCount`);
  assert.ok(d.seatCounts.every((c) => c <= capacity), `${d.gameType}: no table over capacity`);
  assert.equal(d.seatCounts[0], capacity, `${d.gameType}: fullest table`);
  const remainder = playerCount % capacity;
  const expectedLast = remainder === 0 ? capacity : remainder;
  assert.equal(
    d.seatCounts[d.seatCounts.length - 1],
    expectedLast,
    `${d.gameType}: last table partial fill`
  );
}

const GAMES = [
  { gameType: "poker", capacity: POKER_CAPACITY, tier: "beginner", buyIn: 100000 },
  { gameType: "trix", capacity: 4, tier: "beginner", buyIn: 1000 },
  { gameType: "tarneeb41", capacity: 4, tier: "beginner", buyIn: 1000 },
];

const PLAYER_COUNT = 100;

for (const cfg of GAMES) {
  test(`${cfg.gameType}: ${PLAYER_COUNT} players at same stake → balanced tables (cap ${cfg.capacity})`, async () => {
    const store = createAllocationStore({ capacity: cfg.capacity, gameType: cfg.gameType });
    await store.joinConcurrent(PLAYER_COUNT, cfg.tier, cfg.buyIn);
    const d = store.distribution();

    // #region agent log
    agentLog(`${cfg.gameType} distribution`, d, "H1");
    // #endregion

    console.log(
      `[${cfg.gameType}] ${PLAYER_COUNT} players → ${d.tableCount} tables | seats: ${d.seatCounts.join(", ")} | lobby: ${d.stakeSeatedCount} يلعبون`
    );

    assertDistribution(d, PLAYER_COUNT, cfg.capacity);
  });
}

test("all games: no table exceeds capacity under concurrent burst", async () => {
  const results = await Promise.all(
    GAMES.map(async (cfg) => {
      const store = createAllocationStore({ capacity: cfg.capacity, gameType: cfg.gameType });
      await store.joinConcurrent(PLAYER_COUNT, cfg.tier, cfg.buyIn);
      return store.distribution();
    })
  );

  // #region agent log
  agentLog("all games summary", { results }, "H2");
  // #endregion

  for (const d of results) {
    assert.ok(d.seatCounts.every((c) => c <= d.capacity));
  }
});

console.log("table.pool-100-players.test.js: all tests registered");
