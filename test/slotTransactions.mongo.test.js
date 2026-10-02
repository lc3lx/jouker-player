process.env.NODE_ENV = "test";
process.env.POSEIDON_WALLET_MODE = "mongo";
process.env.ZENOBIA_WALLET_MODE = "mongo";
process.env.GOLDEN_TREE_WALLET_MODE = "mongo";
process.env.KING_ARTH_SESSION_MODE = "mongo";
process.env.REQUIRE_MONGO_TRANSACTIONS = "true";
process.env.ALLOW_NON_TRANSACTION_FALLBACK = "false";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
let server;
before(async () => {
  server = await MongoMemoryReplSet.create({ binary: { version: "7.0.9", systemBinary: process.env.MONGOMS_SYSTEM_BINARY || (process.platform === "win32" ? "C:/Program Files/MongoDB/Server/7.0/bin/mongod.exe" : undefined) }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(server.getUri(), { autoCreate: false, autoIndex: false });
  await require("../services/slotProductionSchemaService").ensureSlotProductionIndexes();
  await require("../models/walletModel").init();
  await require("../models/slotOperationModel").init();
  for (const folder of ["poseidon","zenobia","goldenTree"]) await require(`../models/${folder}BonusSessionModel`).init();
  await require("../models/kingArthBonusSessionModel").init();
  await require("../models/poseidonJackpotRoundModel").init();
});

test("local replica set is detected even with a localhost URI and stale standalone hint", async () => {
  const ledger = require("../services/walletLedgerService");
  const names = ["APP_MODE", "REQUIRE_MONGO_TRANSACTIONS", "ALLOW_NON_TRANSACTION_FALLBACK", "MONGO_STANDALONE", "DB_URI"];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { APP_MODE: "beta", REQUIRE_MONGO_TRANSACTIONS: "false",
    ALLOW_NON_TRANSACTION_FALLBACK: "true", MONGO_STANDALONE: "true", DB_URI: "mongodb://127.0.0.1/game" });
  ledger.resetMongoTransactionProbeForTests();
  try {
    assert.equal(await ledger.probeMongoTransactions(), "supported");
    await ledger.withMongoTransaction(async session => assert.ok(session));
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
    ledger.resetMongoTransactionProbeForTests();
  }
});

test("production startup creates slot collections and unique constraints with autoIndex disabled", async () => {
  const Receipt = require("../models/slotOperationModel");
  const indexes = await Receipt.collection.indexes();
  assert.ok(indexes.some(i => i.unique && i.key.userId === 1 && i.key.game === 1 && i.key.requestId === 1));
  const collections = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
  for (const name of ["golden_tree_bonus_sessions", "king_arth_bonus_sessions", "slot_operations"]) {
    assert.ok(collections.some(c => c.name === name));
  }
});

test("Zeus: failed money transaction cannot advance a durable bonus session", async () => {
  const state = require("../games/dice/kingArthRoundState"), Wallet = require("../models/walletModel");
  const ledger = require("../services/walletLedgerService");
  const user = String(new mongoose.Types.ObjectId()), table = "king-arth";
  await Wallet.create({ user, balance: 1e8 });
  await state.getFreeSpinSession(user, table);
  const opened = { remaining: 10, lockedBaseBet: 10000, roundWon: 0, roundCap: 50000000, totalMultiplier: 0, economyVersion: 2 };
  await ledger.withMongoTransaction(session => state.commitSession(user, table, null, opened, session));
  const before = await state.getFreeSpinSession(user, table);
  await assert.rejects(ledger.withMongoTransaction(async session => {
    await ledger.ledgerDeposit({ session, userId:user, amount:1000, ledgerType:"game_win" });
    await state.commitSession(user,table,before,{ ...before, remaining:9, totalMultiplier:100 },session);
    throw new Error("injected Zeus failure");
  }), /injected Zeus failure/);
  assert.deepEqual(await state.getFreeSpinSession(user,table),before);
  assert.equal((await Wallet.findOne({user}).lean()).balance,1e8);
});
after(async () => { await mongoose.disconnect(); if (server) await server.stop(); });

test("Zeus: durable nonce prevents duplicate payout across nodes and rolls back on failure", async () => {
  const { recordSpinReceipt } = require("../games/dice/kingArthSettlement");
  const ledger = require("../services/walletLedgerService");
  const Wallet = require("../models/walletModel"), user = String(new mongoose.Types.ObjectId());
  await Wallet.create({ user, balance: 1e8 });
  const settle = nonce => ledger.withMongoTransaction(async session => {
    await recordSpinReceipt(user, "king-arth", nonce, session);
    await ledger.ledgerDeposit({ session, userId: user, amount: 1000, ledgerType: "game_win" });
  });
  const results = await Promise.allSettled([settle("123"), settle("000123")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await Wallet.findOne({ user }).lean()).balance, 1e8 + 1000);
  await assert.rejects(ledger.withMongoTransaction(async session => {
    await recordSpinReceipt(user, "king-arth", "124", session);
    throw new Error("injected nonce failure");
  }), /injected nonce failure/);
  await settle("124");
  assert.equal((await Wallet.findOne({ user }).lean()).balance, 1e8 + 2000);
});

test("Zeus jackpot entitlement rolls back with money and survives a committed reconnect", async () => {
  const jackpot = require("../games/dice/kingArthJackpot");
  const operation = require("../games/utils/slotOperation");
  const ledger = require("../services/walletLedgerService");
  const userId = String(new mongoose.Types.ObjectId());
  let aborted;
  await assert.rejects(ledger.withMongoTransaction(session => operation.withContext(session, [], async () => {
    aborted = await jackpot.createRoundForSpin({ userId, spinId: "aborted", betAmount: 10000 });
    throw new Error("injected jackpot failure");
  })), /injected jackpot failure/);
  assert.equal(await jackpot.recoverRound(aborted.roundId, userId), null);
  const jobs = [];
  const committed = await ledger.withMongoTransaction(session => operation.withContext(session, jobs,
    () => jackpot.createRoundForSpin({ userId, spinId: "committed", betAmount: 10000 })));
  for (const job of jobs) await job();
  require("../games/poseidon/jackpot/jackpotService")._clearStubForTests();
  assert.equal((await jackpot.recoverRound(committed.roundId, userId)).roundId, committed.roundId);
});

for (const folder of ["poseidon", "zenobia", "goldenTree"]) test(`${folder}: wallet, entitlement and retry receipt commit together in Mongo`, async () => {
  const Wallet = require("../models/walletModel"), Session = require(`../models/${folder}BonusSessionModel`), Receipt = require("../models/slotOperationModel");
  const service = require(`../games/${folder}/${folder}Service`), manager = require(`../games/${folder}/roundManager`);
  const user = String(new mongoose.Types.ObjectId());
  await Wallet.create({ user, balance: 1e9 });
  const buy = () => folder === "goldenTree" ? service.executeBuyBonus(user, "Triple",10000,{requestId:"mongo_purchase_01"}) : service.executeBuyBonus(user,10000,{requestId:"mongo_purchase_01"});
  const purchased = await buy();
  assert.equal((await Wallet.findOne({user}).lean()).balance, purchased.balance);
  assert.equal((await Session.findOne({userId:user}).lean()).economyVersion, 2);
  manager.replaceBonusSession(user, null); // simulate process/reconnect cache loss
  assert.deepEqual(await buy(), purchased);
  const before = await Session.findOne({userId:user}).lean();
  const [spin, replay] = await Promise.all([service.executeSpin(user,10000,{requestId:"mongo_spin_0001"}), service.executeSpin(user,10000,{requestId:"mongo_spin_0001"})]);
  assert.deepEqual(spin,replay);
  const after = await Session.findOne({userId:user}).lean();
  assert.equal(after.freeSpinsRemaining, before.freeSpinsRemaining - 1 + (spin.freeSpinsAwarded || 0));
  assert.equal((await Wallet.findOne({user}).lean()).balance, purchased.balance + spin.totalWin);
  const originalCreate = Receipt.create;
  Receipt.create = async () => { throw new Error("injected receipt failure"); };
  try { await assert.rejects(service.executeSpin(user,10000,{requestId:"mongo_spin_0002"}), /injected receipt failure/); }
  finally { Receipt.create = originalCreate; }
  assert.equal((await Wallet.findOne({user}).lean()).balance, spin.balance);
  assert.deepEqual(await Session.findOne({userId:user}).lean(), after);
  const recovered = await service.getActiveSession(user);
  assert.equal(recovered.freeSpinsRemaining, after.freeSpinsRemaining);
});
