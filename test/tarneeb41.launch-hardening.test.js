const test = require("node:test");
const assert = require("node:assert/strict");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
const roomManager = require("../rooms/roomManager");

const FIXED_TIER_TABLES = {
  beginner: [10000, 40000, 100000, 150000],
  intermediate: [200000, 400000, 800000, 1000000],
  beast: [1500000, 2000000, 5000000, 10000000],
};
const FIXED_TABLE_NUMBERS = [1, 2, 3, 4];

function buildGetTablesFilter(gameType, tier, status = "open") {
  const filter = { gameType };
  if (tier) filter.tier = tier;
  if ((gameType === "tarneeb41" || gameType === "trix") && (!status || status === "open")) {
    filter.status = "open";
    filter.$expr = { $lt: [{ $size: "$seats" }, "$capacity"] };
  } else if (status) {
    filter.status = status;
  } else {
    filter.status = "open";
  }
  return filter;
}

function isJoinableTarneeb41Table(table) {
  return (
    table.gameType === "tarneeb41" &&
    table.status === "open" &&
    table.seats.length < table.capacity
  );
}

function paginateTables(tables, page = 1, limit = 20) {
  const total = tables.length;
  const skip = (page - 1) * limit;
  const data = tables.slice(skip, skip + limit);
  return {
    results: data.length,
    paginationResult: {
      currentPage: page,
      limit,
      numberOfPages: Math.ceil(total / limit),
      next: page * limit < total ? page + 1 : null,
    },
    data,
  };
}

function mkFourHumans(tableId = "countdown_table") {
  const game = new Tarneeb41Game(`room_${tableId}`, { mongoTableId: tableId });
  for (let i = 0; i < 4; i += 1) {
    game.players.push({
      userId: `u${i}`,
      socketId: `s${i}`,
      seatIndex: i,
      isBot: false,
      displayName: `P${i}`,
      chips: 1000,
    });
  }
  return game;
}

function mkTableDoc(seatCount, tableId = "t1", tableNumber = 1) {
  const seats = Array.from({ length: seatCount }, (_, i) => ({
    user: { _id: `u${i}`, name: `P${i}` },
    chips: 1000,
  }));
  return {
    _id: tableId,
    gameType: "tarneeb41",
    tier: "beginner",
    tableNumber,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 4,
    status: seatCount >= 4 ? "playing" : "open",
    seats,
  };
}

function createMemoryTarneeb41Store(initialTableId = "seed_table") {
  const tables = new Map();
  let idCounter = 1;
  let storeLock = Promise.resolve();

  const withStoreLock = async (fn) => {
    const run = storeLock.then(fn);
    storeLock = run.catch(() => {});
    return run;
  };

  const seed = {
    _id: initialTableId,
    gameType: "tarneeb41",
    tier: "beginner",
    tableNumber: 1,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 4,
    status: "open",
    seats: [],
    save: async function save() {
      tables.set(String(this._id), this);
      return this;
    },
  };
  tables.set(String(initialTableId), seed);

  const makeQuery = (resolveDoc) => {
    const q = {
      sort() {
        return q;
      },
      select() {
        return q;
      },
      session() {
        return q;
      },
      populate() {
        return Promise.resolve(resolveDoc());
      },
    };
    q.then = (onFulfilled, onRejected) =>
      Promise.resolve(resolveDoc()).then(onFulfilled, onRejected);
    return q;
  };

  const matchesFilter = (t, filter) => {
    if (filter.gameType && t.gameType !== filter.gameType) return false;
    if (filter.tier && t.tier !== filter.tier) return false;
    if (filter.status && t.status !== filter.status) return false;
    if (filter.minBuyIn != null && t.minBuyIn !== filter.minBuyIn) return false;
    if (filter.maxBuyIn != null && t.maxBuyIn !== filter.maxBuyIn) return false;
    if (filter.$expr) {
      if (!(t.seats.length < t.capacity)) return false;
    }
    return true;
  };

  const Table = {
    findById(id) {
      return makeQuery(() => tables.get(String(id)) || null);
    },
    findOne(filter) {
      return makeQuery(() => {
        const candidates = [...tables.values()].filter((t) => matchesFilter(t, filter));
        if (filter.status === "open" && filter.$expr) {
          return candidates.sort((a, b) => a.tableNumber - b.tableNumber)[0] || null;
        }
        if (filter.gameType === "tarneeb41" && filter.tier && !filter.status) {
          return candidates.sort((a, b) => b.tableNumber - a.tableNumber)[0] || null;
        }
        return candidates[0] || null;
      });
    },
    create(docs, opts) {
      const doc = Array.isArray(docs) ? docs[0] : docs;
      idCounter += 1;
      const created = {
        ...doc,
        _id: `dyn_${idCounter}`,
        seats: doc.seats ? [...doc.seats] : [],
        save: async function save() {
          tables.set(String(this._id), this);
          return this;
        },
      };
      tables.set(String(created._id), created);
      return Promise.resolve([created]);
    },
  };

  return { Table, tables, initialTableId, withStoreLock };
}

async function withMockedTarneeb41Join(fn) {
  const store = createMemoryTarneeb41Store();
  const Table = require("../models/tableModel");
  const walletLedger = require("../services/walletLedgerService");
  const lobbyRealtime = require("../utils/lobbyRealtime");

  const originalFindById = Table.findById.bind(Table);
  const originalFindOne = Table.findOne.bind(Table);
  const originalCreate = Table.create.bind(Table);
  const originalTxn = walletLedger.withMongoTransaction;
  const originalTransfer = walletLedger.transferToLocked;
  const originalEmit = lobbyRealtime.emitTablesUpdated;

  Table.findById = store.Table.findById;
  Table.findOne = store.Table.findOne;
  Table.create = store.Table.create;
  walletLedger.withMongoTransaction = async (work) => store.withStoreLock(() => work({}));
  walletLedger.transferToLocked = async () => {};
  lobbyRealtime.emitTablesUpdated = () => {};

  delete require.cache[require.resolve("../services/tableService")];
  const tableService = require("../services/tableService");

  try {
    return await fn(store, tableService);
  } finally {
    Table.findById = originalFindById;
    Table.findOne = originalFindOne;
    Table.create = originalCreate;
    walletLedger.withMongoTransaction = originalTxn;
    walletLedger.transferToLocked = originalTransfer;
    lobbyRealtime.emitTablesUpdated = originalEmit;
    delete require.cache[require.resolve("../services/tableService")];
    require("../services/tableService");
  }
}

for (const playerCount of [20, 50, 100, 500]) {
  test(`lobby scalability: ${playerCount} players — all joinable tables visible (no 1–4 cap)`, () => {
    const tableCount = Math.ceil(playerCount / 4);
    const filter = buildGetTablesFilter("tarneeb41", "beginner", "open");
    assert.equal(filter.tableNumber, undefined);

    const tables = Array.from({ length: tableCount }, (_, i) => ({
      gameType: "tarneeb41",
      tier: "beginner",
      tableNumber: i + 5,
      status: "open",
      capacity: 4,
      seats: [{ user: "a" }],
    }));

    const joinable = tables.filter(isJoinableTarneeb41Table);
    assert.equal(joinable.length, tableCount);

    const page1 = paginateTables(joinable, 1, 20);
    assert.equal(page1.data.length, Math.min(20, tableCount));
    assert.equal(page1.paginationResult.next, tableCount > 20 ? 2 : null);

    if (tableCount > 20) {
      const page2 = paginateTables(joinable, 2, 20);
      assert.equal(page1.data.length + page2.data.length, Math.min(tableCount, 40));
    }

    const trixFilter = buildGetTablesFilter("trix", "beginner", "open");
    assert.equal(trixFilter.tableNumber, undefined);
    assert.ok(trixFilter.$expr);
  });
}

test("concurrent joins: 10 simultaneous — no TABLE_FULL when overflow table exists", async () => {
  await withMockedTarneeb41Join(async (store, { joinTarneeb41WithRetry }) => {
    const joins = Array.from({ length: 10 }, (_, i) =>
      joinTarneeb41WithRetry({
        userId: `user_${i}`,
        playerId: `player_${i}`,
        buyIn: 10000,
        initialTableId: store.initialTableId,
        tier: "beginner",
      })
    );
    const results = await Promise.all(joins);
    assert.equal(results.length, 10);
    assert.ok(results.every((id) => typeof id === "string" && id.length > 0));
    const uniqueTables = new Set(results);
    assert.ok(uniqueTables.size >= 2);
    assert.ok([...store.tables.values()].every((t) => t.seats.length <= t.capacity));
  });
});

test("concurrent joins: 50 simultaneous — no TABLE_FULL when overflow table exists", async () => {
  await withMockedTarneeb41Join(async (store, { joinTarneeb41WithRetry }) => {
    const joins = Array.from({ length: 50 }, (_, i) =>
      joinTarneeb41WithRetry({
        userId: `user_${i}`,
        playerId: `player_${i}`,
        buyIn: 10000,
        initialTableId: store.initialTableId,
        tier: "beginner",
      })
    );
    const results = await Promise.all(joins);
    assert.equal(results.length, 50);
    const seated = [...store.tables.values()].reduce((n, t) => n + t.seats.length, 0);
    assert.equal(seated, 50);
    assert.ok([...store.tables.values()].every((t) => t.seats.length <= t.capacity));
  });
});

test("findAvailableTarneeb41Table creates dynamic table beyond tableNumber 4", async () => {
  await withMockedTarneeb41Join(async (store, { findAvailableTarneeb41Table }) => {
    store.tables.delete(store.initialTableId);
    for (let n = 2; n <= 5; n += 1) {
      store.tables.set(`full_${n}`, {
        _id: `full_${n}`,
        gameType: "tarneeb41",
        tier: "beginner",
        tableNumber: n,
        minBuyIn: 10000,
        maxBuyIn: 10000,
        capacity: 4,
        status: "playing",
        seats: Array.from({ length: 4 }, (_, i) => ({ user: `u${n}_${i}`, chips: 10000 })),
        save: async function save() {
          store.tables.set(String(this._id), this);
          return this;
        },
      });
    }

    const table = await findAvailableTarneeb41Table("beginner", 10000);
    assert.ok(table.tableNumber >= 6);
    assert.equal(table.status, "open");
    assert.equal(table.seats.length, 0);
  });
});

for (const leaveAt of [14, 5, 1]) {
  test(`countdown leave at ${leaveAt}s — game does not start with <4 humans`, () => {
    const game = mkFourHumans();
    try {
      game.setCountdownStartGate(async () => game.humanCount() === 4);
      assert.equal(game.startGameCountdown(), true);
      game.countdownSeconds = leaveAt;
      game.players.pop();
      assert.equal(game.cancelGameCountdown("seats_changed"), true);
      assert.equal(game.humanCount(), 3);
      assert.equal(game.isReadyForCountdown(), false);
      assert.equal(game.startGame(), false);
      assert.notEqual(game.state, "bidding_syrian");
    } finally {
      game.destroy();
    }
  });
}

test("countdown leave at 0s — gate blocks start when roster drops below 4", async () => {
  const tableId = `gate_zero_${Date.now()}`;
  const game = mkFourHumans(tableId);
  roomManager.tarneeb41GamesByTableId.set(tableId, game);
  const Table = require("../models/tableModel");
  const originalFindById = Table.findById.bind(Table);
  Table.findById = () => ({
    populate() {
      return Promise.resolve(mkTableDoc(3, tableId));
    },
  });
  delete require.cache[require.resolve("../services/tableService")];
  const { validateTarneeb41StartEligibility } = require("../services/tableService");
  try {
    game.setCountdownStartGate(async () => {
      const result = await validateTarneeb41StartEligibility(tableId, game);
      return result.ok;
    });
    assert.equal(game.startGameCountdown(), true);
    game.players.pop();
    game.syncLobbyFromTable(mkTableDoc(3, tableId), () => null);
    await game._onCountdownElapsed();
    assert.equal(game.state, "waiting");
    assert.notEqual(game.state, "bidding_syrian");
    assert.equal(game.humanCount(), 3);
  } finally {
    Table.findById = originalFindById;
    delete require.cache[require.resolve("../services/tableService")];
    require("../services/tableService");
    game.destroy();
    roomManager.tarneeb41GamesByTableId.delete(tableId);
  }
});

test("validateTarneeb41StartEligibility rejects roster below four at countdown end", async () => {
  const tableId = `validate_${Date.now()}`;
  const game = mkFourHumans(tableId);
  game.players.pop();
  roomManager.tarneeb41GamesByTableId.set(tableId, game);

  const Table = require("../models/tableModel");
  const originalFindById = Table.findById.bind(Table);
  Table.findById = () => ({
    populate() {
      return Promise.resolve(mkTableDoc(3, tableId));
    },
  });
  delete require.cache[require.resolve("../services/tableService")];
  const { validateTarneeb41StartEligibility } = require("../services/tableService");

  try {
    const result = await validateTarneeb41StartEligibility(tableId, game);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "seats_not_four");
  } finally {
    Table.findById = originalFindById;
    delete require.cache[require.resolve("../services/tableService")];
    require("../services/tableService");
    game.destroy();
    roomManager.tarneeb41GamesByTableId.delete(tableId);
  }
});

test("startGame requires exactly four humans even after countdown", () => {
  const game = mkFourHumans();
  try {
    game.state = "countdown";
    game.players.pop();
    assert.equal(game.startGame(), false);
    assert.notEqual(game.state, "bidding_syrian");
  } finally {
    game.destroy();
  }
});
