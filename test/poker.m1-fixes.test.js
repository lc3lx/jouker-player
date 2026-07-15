"use strict";

/**
 * M1 money-safety regression suite (audit fixes C-1, C-4, C-5, N-1, N-2, N-3, H-2).
 * Runs against a real in-memory Mongo REPLICA SET so the transactional settlement
 * paths execute exactly as production does.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Table = require("../models/tableModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const WalletTableLock = require("../models/walletTableLockModel");
const HandHistory = require("../models/handHistoryModel");
const HouseWallet = require("../models/houseWalletModel");
const Jackpot = require("../models/jackpotModel");

const { PokerTable } = require("../sockets/tableGame");
const {
  withMongoTransaction,
  resetMongoTransactionProbeForTests,
  allowNonTransactionFallbackForChecks,
} = require("../services/walletLedgerService");
const {
  enqueuePlayer,
  dequeuePlayer,
  getQueuePosition,
} = require("../services/pokerWaitingQueueService");
const { permanentLeavePokerTable } = require("../services/pokerVacateService");
const spectatorDelay = require("../services/spectatorDelayService");
const pokerQueueRedis = require("../utils/redis/pokerQueueRedis");

let replSet = null;
const savedEnv = {};
let tableNumberSeq = 9000;

function createNspStub(perUserEvents = new Map()) {
  const socketFor = (uid) => ({
    userId: uid,
    emit(event, payload) {
      if (!perUserEvents.has(uid)) perUserEvents.set(uid, []);
      perUserEvents.get(uid).push({ event, payload });
    },
  });
  const sockets = [];
  return {
    _sockets: sockets,
    addSocket(uid) {
      const s = socketFor(uid);
      sockets.push(s);
      return s;
    },
    to() {
      return { emit() {} };
    },
    in() {
      return {
        async fetchSockets() {
          return sockets;
        },
      };
    },
  };
}

async function makeUserWallet({ balance = 0, lockedBalance = 0 } = {}) {
  const userId = new mongoose.Types.ObjectId();
  await Wallet.create({ user: userId, balance, lockedBalance });
  return userId;
}

async function makeTableDoc(userIds, { chips = 10000 } = {}) {
  tableNumberSeq += 1;
  return Table.create({
    gameType: "poker",
    tier: "beginner",
    tableNumber: tableNumberSeq,
    smallBlind: 100,
    bigBlind: 200,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 9,
    status: "waiting",
    seats: userIds.map((u, i) => ({ user: u, chips, seatPosition: i })),
  });
}

function makeGame(tableDoc, nsp = createNspStub()) {
  const g = new PokerTable(nsp, tableDoc);
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};
  g.saveSnapshot = async () => {};
  g.scheduleNextHand = () => {};
  return g;
}

/** Arrange a two-player hand ready for settlement: pot 4000, 2000 invested each. */
function primeHandForSettlement(g, handId) {
  g.running = true;
  g.round = "river";
  g.currentHandId = handId;
  g.handStartedAt = Date.now();
  g.currentHandActions = [];
  g.handJackpotFees = 0;
  for (const s of g.seats) {
    s.handStartChips = 10000;
    s.chips = 8000;
    s.invested = 2000;
    s.bet = 0;
    s.inHand = true;
    s.folded = false;
    s.hole = ["As", "Kd"];
  }
  g.pot = 4000;
  g.handStartTotal = 20000;
}

test.before(async () => {
  for (const k of [
    "MONGODB_URI",
    "MONGO_URI",
    "DB_URI",
    "MONGO_STANDALONE",
    "NODE_ENV",
    "RAKE_PERCENT",
    "APP_MODE",
    "REQUIRE_MONGO_TRANSACTIONS",
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.NODE_ENV = "test";
  process.env.RAKE_PERCENT = "0.05";
  delete process.env.MONGO_STANDALONE;
  delete process.env.APP_MODE;
  delete process.env.REQUIRE_MONGO_TRANSACTIONS;

  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const uri = replSet.getUri();
  process.env.MONGODB_URI = uri;
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;

  resetMongoTransactionProbeForTests();
  pokerQueueRedis.setRedisClient(null);

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(uri, { dbName: "poker_m1_fixes" });
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) {
    await replSet.stop();
    replSet = null;
  }
  resetMongoTransactionProbeForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ─── C-1 ────────────────────────────────────────────────────────────────────

test("C-1 success: commit-then-apply settles wallets, mongo seats and RAM consistently", async () => {
  await HouseWallet.deleteMany({});
  const a = await makeUserWallet({ lockedBalance: 10000 });
  const b = await makeUserWallet({ lockedBalance: 10000 });
  const tableDoc = await makeTableDoc([a, b]);
  await WalletTableLock.create([
    { user: a, table: tableDoc._id, amount: 10000 },
    { user: b, table: tableDoc._id, amount: 10000 },
  ]);

  const g = makeGame(tableDoc);
  primeHandForSettlement(g, "h-c1-success");

  const payouts = new Map([[0, 4000]]);
  await g.persistAndPrepareNext([], payouts, [0], { reason: "fold" }, { manageLifecycle: false });

  // rake = 5% of 4000 = 200, taken from the winner's payout
  assert.equal(g.frozen, false);
  assert.equal(g.seats[0].chips, 11800);
  assert.equal(g.seats[1].chips, 8000);
  assert.equal(g.pot, 0);

  const wa = await Wallet.findOne({ user: a }).lean();
  const wb = await Wallet.findOne({ user: b }).lean();
  assert.equal(wa.lockedBalance, 11800);
  assert.equal(wb.lockedBalance, 8000);

  const tableAfter = await Table.findById(tableDoc._id).lean();
  const seatChips = tableAfter.seats.map((s) => s.chips).sort((x, y) => y - x);
  assert.deepEqual(seatChips, [11800, 8000]);
  assert.equal(tableAfter.activeSettlementId, null);

  const hand = await HandHistory.findOne({ handId: "h-c1-success" }).lean();
  assert.ok(hand, "HandHistory row persisted");
  assert.equal(hand.rake, 200);

  const house = await HouseWallet.findOne({}).lean();
  assert.ok(house, "house wallet auto-created in test env");
  // house collected exactly the rake as counterparty income
  const houseTxDelta = house.balance - 1000000000;
  assert.equal(houseTxDelta, 200);
});

test("C-1 failure: settlement rollback leaves RAM untouched and freezes the table", async () => {
  const a = await makeUserWallet({ lockedBalance: 10000 });
  const b = await makeUserWallet({ lockedBalance: 10000 });
  const tableDoc = await makeTableDoc([a, b]);

  const g = makeGame(tableDoc);
  primeHandForSettlement(g, "h-c1-failure");

  // Force the transaction to throw mid-way: production mode + missing house wallet
  // makes applyHouseSettlementDelta throw HOUSE_WALLET_MISSING inside the txn.
  await HouseWallet.deleteMany({});
  const envBefore = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const payouts = new Map([[0, 4000]]);
    await g.persistAndPrepareNext([], payouts, [0], { reason: "fold" }, { manageLifecycle: false });
  } finally {
    process.env.NODE_ENV = envBefore;
  }

  // RAM must equal the rolled-back DB: no chips advanced, pot intact, table frozen.
  assert.equal(g.frozen, true);
  assert.equal(g.running, false);
  assert.equal(g.seats[0].chips, 8000);
  assert.equal(g.seats[1].chips, 8000);
  assert.equal(g.pot, 4000);

  const wa = await Wallet.findOne({ user: a }).lean();
  const wb = await Wallet.findOne({ user: b }).lean();
  assert.equal(wa.lockedBalance, 10000, "winner wallet untouched after rollback");
  assert.equal(wb.lockedBalance, 10000, "loser wallet untouched after rollback");

  const hand = await HandHistory.findOne({ handId: "h-c1-failure" }).lean();
  assert.equal(hand, null, "no HandHistory row for the failed settlement");

  const tableAfter = await Table.findById(tableDoc._id).lean();
  assert.equal(tableAfter.activeSettlementId, null, "settlement lock released on failure");
});

test("C-1 idempotency: replaying the same handId never double-applies wallets or RAM", async () => {
  await HouseWallet.deleteMany({});
  const a = await makeUserWallet({ lockedBalance: 10000 });
  const b = await makeUserWallet({ lockedBalance: 10000 });
  const tableDoc = await makeTableDoc([a, b]);

  const g = makeGame(tableDoc);
  primeHandForSettlement(g, "h-c1-replay");
  const payouts = new Map([[0, 4000]]);
  await g.persistAndPrepareNext([], payouts, [0], { reason: "fold" }, { manageLifecycle: false });

  const chipsAfterFirst = g.seats.map((s) => s.chips);
  const lockedAfterFirst = [
    (await Wallet.findOne({ user: a }).lean()).lockedBalance,
    (await Wallet.findOne({ user: b }).lean()).lockedBalance,
  ];

  // Replay the SAME hand (e.g. crash-recovery double invoke).
  g.currentHandId = "h-c1-replay";
  g.pot = 0;
  await g.persistAndPrepareNext([], payouts, [0], { reason: "fold" }, { manageLifecycle: false });

  assert.deepEqual(
    g.seats.map((s) => s.chips),
    chipsAfterFirst,
    "RAM stacks unchanged on replay"
  );
  assert.deepEqual(
    [
      (await Wallet.findOne({ user: a }).lean()).lockedBalance,
      (await Wallet.findOne({ user: b }).lean()).lockedBalance,
    ],
    lockedAfterFirst,
    "wallets unchanged on replay"
  );
  assert.equal(await HandHistory.countDocuments({ handId: "h-c1-replay" }), 1);
});

// ─── C-4 ────────────────────────────────────────────────────────────────────

test("C-4: REQUIRE_MONGO_TRANSACTIONS forces the fallback gate closed", () => {
  const prev = process.env.REQUIRE_MONGO_TRANSACTIONS;
  try {
    process.env.REQUIRE_MONGO_TRANSACTIONS = "true";
    assert.equal(allowNonTransactionFallbackForChecks(), false);
    delete process.env.REQUIRE_MONGO_TRANSACTIONS;
    // beta/test env without the flag → fallback allowed (dev ergonomics preserved)
    assert.equal(allowNonTransactionFallbackForChecks(), true);
  } finally {
    if (prev === undefined) delete process.env.REQUIRE_MONGO_TRANSACTIONS;
    else process.env.REQUIRE_MONGO_TRANSACTIONS = prev;
  }
});

// ─── C-5 ────────────────────────────────────────────────────────────────────

test("C-5: jackpot payout is ledgered, decrements the pool atomically, and is idempotent per hand", async () => {
  await Jackpot.deleteMany({});
  const j = await Jackpot.getSingleton();
  j.pot = 100000;
  await j.save();

  const w = await makeUserWallet({ balance: 0 });
  const other = await makeUserWallet({ balance: 0 });
  const tableDoc = await makeTableDoc([w, other]);
  const g = makeGame(tableDoc);
  g.currentHandId = "h-jackpot";
  // Royal flush board for seat 0
  g.seats[0].hole = ["Ah", "Kh"];
  g.seats[1].hole = ["2d", "3c"];
  g.community = ["Qh", "Jh", "Th", "2s", "3s"];

  await g.applyJackpotPayout([0]);

  const wallet1 = await Wallet.findOne({ user: w }).lean();
  assert.equal(wallet1.balance, 100000, "royal flush pays 100% of the pool");
  const ledger = await WalletTransaction.findOne({
    userId: w,
    type: "island_jackpot_win",
    handId: "h-jackpot",
  }).lean();
  assert.ok(ledger, "jackpot credit went through the ledger, not the legacy path");
  assert.equal((await Jackpot.getSingleton()).pot, 0, "pool decremented in the same txn");

  // Replay with a refilled pool: idempotency guard must refuse a second credit.
  const j2 = await Jackpot.getSingleton();
  j2.pot = 100000;
  await j2.save();
  await g.applyJackpotPayout([0]);

  assert.equal((await Wallet.findOne({ user: w }).lean()).balance, 100000, "no double credit");
  assert.equal((await Jackpot.getSingleton()).pot, 100000, "pool untouched on replay");
});

// ─── N-1 ────────────────────────────────────────────────────────────────────

test("N-1: leave-cashout is blocked while settlement is in progress and allowed after", async () => {
  const a = await makeUserWallet({ lockedBalance: 5000 });
  const b = await makeUserWallet({ lockedBalance: 5000 });
  const tableDoc = await makeTableDoc([a, b], { chips: 5000 });
  await WalletTableLock.create([
    { user: a, table: tableDoc._id, amount: 5000 },
    { user: b, table: tableDoc._id, amount: 5000 },
  ]);

  const g = makeGame(tableDoc);
  g.currentHandId = "h-n1";
  await g._acquireSettlementLock();

  const blocked = await permanentLeavePokerTable({ tableId: tableDoc._id, userId: a });
  assert.equal(blocked.left, false);
  assert.equal(blocked.reason, "SETTLEMENT_IN_PROGRESS");
  assert.equal((await Wallet.findOne({ user: a }).lean()).balance, 0, "no cashout while locked");

  await g._releaseSettlementLock();

  const allowed = await permanentLeavePokerTable({ tableId: tableDoc._id, userId: a });
  assert.equal(allowed.left, true);
  assert.equal(allowed.cashedOut, 5000);
  const wa = await Wallet.findOne({ user: a }).lean();
  assert.equal(wa.balance, 5000);
  assert.equal(wa.lockedBalance, 0);
});

// ─── N-2 ────────────────────────────────────────────────────────────────────

test("N-2: queued-only player gets the locked buy-in refunded on dequeue", async () => {
  const seatUsers = [];
  for (let i = 0; i < 9; i++) seatUsers.push(new mongoose.Types.ObjectId());
  const tableDoc = await makeTableDoc(seatUsers); // full table → queue only
  const q = await makeUserWallet({ balance: 10000 });

  await withMongoTransaction(async (session) => {
    const r = await enqueuePlayer({
      session,
      userId: q,
      playerId: null,
      buyIn: 10000,
      tableId: tableDoc._id,
    });
    assert.equal(r.queued, true);
  });

  let wq = await Wallet.findOne({ user: q }).lean();
  assert.equal(wq.balance, 0);
  assert.equal(wq.lockedBalance, 10000, "buy-in locked on enqueue");
  assert.equal(await getQueuePosition(tableDoc._id, q), 1);

  // The leaveTable N-2 branch: queued-only → dequeue + refund.
  await withMongoTransaction(async (session) => {
    await dequeuePlayer({ session, userId: q, tableId: tableDoc._id });
  });

  wq = await Wallet.findOne({ user: q }).lean();
  assert.equal(wq.balance, 10000, "locked buy-in refunded to balance");
  assert.equal(wq.lockedBalance, 0);
  assert.equal(await getQueuePosition(tableDoc._id, q), -1);
});

// ─── N-3 ────────────────────────────────────────────────────────────────────

test("N-3: spectators never see live state; the drain pumps only delayed frames", async () => {
  const perUser = new Map();
  const nsp = createNspStub(perUser);
  nsp.addSocket("player1");
  nsp.addSocket("spec1");

  const tableDoc = {
    _id: "spec-table-n3",
    smallBlind: 100,
    bigBlind: 200,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 9,
    seats: [{ user: { _id: "player1", name: "P1" }, chips: 9000 }],
  };
  // NB: spectatorDelayService floors per-table overrides at 1000ms.
  process.env["SPECTATOR_DELAY_MS_spec-table-n3"] = "1000";
  spectatorDelay.clearTable("spec-table-n3");

  const g = new PokerTable(createNspStub(), tableDoc);
  g.nsp = nsp;
  g.saveSnapshot = async () => {};
  g.syncMongoTableStatus = async () => {};
  g.spectatorUserIds.add("spec1");
  g.running = true;
  g.round = "flop";
  g.pot = 7777;
  g.community = ["As", "Kd", "2c"];
  g.seats[0].bet = 500;
  g.seats[0].inHand = true;

  try {
    await g.broadcastState();

    const specEvents = perUser.get("spec1") || [];
    assert.equal(
      specEvents.filter((e) => e.event === "table_state").length,
      0,
      "no live frame reaches the spectator before the delay elapses"
    );
    const playerEvents = perUser.get("player1") || [];
    assert.ok(
      playerEvents.some((e) => e.event === "table_state" && e.payload.pot === 7777),
      "seated player still gets live state"
    );

    // Pre-delay placeholder hides all live-hand data.
    const waiting = g.buildSpectatorWaitingState();
    assert.equal(waiting.round, "idle");
    assert.equal(waiting.pot, 0);
    assert.equal(waiting.stateRevision, 0);
    assert.deepEqual(waiting.community, []);
    assert.equal(waiting.seats[0].bet, 0);
    assert.deepEqual(waiting.seats[0].hole, [null, null]);

    // After the delay window the drain delivers the buffered frame.
    await new Promise((r) => setTimeout(r, 1100));
    await g.drainSpectatorFrame();
    const specAfter = (perUser.get("spec1") || []).filter((e) => e.event === "table_state");
    assert.equal(specAfter.length, 1, "exactly one delayed frame delivered");
    assert.equal(specAfter[0].payload.pot, 7777, "delivered frame is the buffered one");

    // Dedupe: draining again without a new ready frame emits nothing.
    await g.drainSpectatorFrame();
    assert.equal(
      (perUser.get("spec1") || []).filter((e) => e.event === "table_state").length,
      1
    );
  } finally {
    g.stopSpectatorDrain();
    spectatorDelay.clearTable("spec-table-n3");
    delete process.env["SPECTATOR_DELAY_MS_spec-table-n3"];
  }
});

// ─── H-2 ────────────────────────────────────────────────────────────────────

test("H-2: action-lock heartbeat starts on acquire, stops on release; Redis renew is token-checked", async () => {
  // Part A — heartbeat lifecycle with the in-memory manager.
  const tableDoc = {
    _id: "h2-table",
    smallBlind: 100,
    bigBlind: 200,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 9,
    seats: [],
  };
  const g = new PokerTable(createNspStub(), tableDoc);
  assert.equal(await g.acquireActionLock(), true);
  assert.ok(g.lockHeartbeatTimer, "heartbeat running while lock held");
  await g.releaseActionLock();
  assert.equal(g.lockHeartbeatTimer, null, "heartbeat cleared on release");

  // Part B — Redis lease renewal only extends when the token matches.
  const fakeRedis = {
    store: new Map(),
    async set(key, value, opts) {
      if (opts?.NX && this.store.has(key)) return null;
      this.store.set(key, { value, px: opts?.PX ?? null });
      return "OK";
    },
    async eval(lua, { keys, arguments: args }) {
      const entry = this.store.get(keys[0]);
      if (!entry || entry.value !== args[0]) return 0;
      if (lua.includes("PEXPIRE")) {
        entry.px = Number(args[1]);
        return 1;
      }
      this.store.delete(keys[0]);
      return 1;
    },
  };
  const g2 = new PokerTable(createNspStub(), { ...tableDoc, _id: "h2-redis" }, { redis: fakeRedis });
  g2.saveSnapshot = async () => {};
  assert.equal(await g2.lockManager.acquire("h2-redis"), true);
  assert.equal(await g2.lockManager.renew("h2-redis"), true, "renew succeeds with valid token");

  // A different holder's token must never be extended by us.
  g2.lockManager.tokens.set("h2-redis", "stolen-token");
  assert.equal(await g2.lockManager.renew("h2-redis"), false, "renew refused on token mismatch");
  await g2.releaseActionLock();
});
