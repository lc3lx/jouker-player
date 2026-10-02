"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const Table = require("../models/tableModel");
const Wallet = require("../models/walletModel");
const Lock = require("../models/walletTableLockModel");
const Ledger = require("../models/walletTransactionModel");
const walletLedger = require("../services/walletLedgerService");
const { offerRebuy, confirmRebuy } = require("../services/pokerRebuyService");
const { POKER_STAKES, maximumBuyIn, validBuyIn } = require("../utils/poker/buyInPolicy");
const { PokerTable, GameRegistry } = require("../sockets/tableGame");
const { canBeDealtIntoHand } = require("../utils/poker/playerState");
let repl;
test.before(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.DB_URI = repl.getUri();
  process.env.REQUIRE_MONGO_TRANSACTIONS = "true";
  walletLedger.resetMongoTransactionProbeForTests();
  await mongoose.connect(repl.getUri(), { dbName: "poker_manual_rebuy" });
  await Promise.all([Table.init(), Wallet.init(), Lock.init(), Ledger.init()]);
});
test.after(async () => { await mongoose.disconnect(); await repl?.stop(); });
let sequence = 0;
async function fixture({ min = 10000, max = 1000000, balance = 2000000, kind = "static" } = {}) {
  const userId = new mongoose.Types.ObjectId();
  const table = await Table.create({ gameType: "poker", tier: "beginner", tableNumber: ++sequence,
    tableKind: kind, smallBlind: 100, bigBlind: 200, minBuyIn: min, maxBuyIn: max,
    seats: [{ user: userId, chips: 0, seatPosition: 4 }] });
  await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return { tableId: table._id, userId };
}
async function request(f, amount, extra = {}) {
  const offer = await offerRebuy(f.tableId, f.userId, 100000);
  return { ...f, offerId: offer.offerId, actionId: `buy:${offer.offerId}`, amount, now: 100001, ...extra };
}

test("all public limits accept both endpoints through ten billion without 32-bit conversion", () => {
  for (const [tier, stakes] of Object.entries(POKER_STAKES)) for (const min of stakes) {
    const max = maximumBuyIn(tier, min);
    assert.equal(validBuyIn(min, min, max), true);
    assert.equal(validBuyIn(max, min, max), true);
    for (const bad of [min - 1, max + 1, min + 0.5, NaN, Infinity]) assert.equal(validBuyIn(bad, min, max), false);
  }
  assert.equal(maximumBuyIn("beast", 10000000), 10000000000);
});
test("offer is durable, private and reconnect does not renew sixty seconds", async (t) => {
  const f = await fixture();
  const offer = await offerRebuy(f.tableId, f.userId, 100000);
  const second = await offerRebuy(f.tableId, f.userId, 110000);
  assert.equal(second.offerId, offer.offerId);
  assert.equal(new Date(second.expiresAt).getTime(), 160000);
  const mongo = await Table.findById(f.tableId).lean();
  const g = new PokerTable({ in: () => ({ fetchSockets: async () => [] }) }, { ...mongo, _id: f.tableId });
  t.after(() => g.disposeTimers());
  g.armRebuyExpiry = () => {};
  g.restoreRebuyOffersFromMongo(mongo);
  assert.equal(g.getPublicState(String(f.userId)).rebuyOffer.offerId, offer.offerId);
  assert.equal(g.getPublicState(null).rebuyOffer, undefined);
  assert.equal(g.getPublicState("other").rebuyOffer, null);
  assert.equal(g.getPublicState(null).seats[0].rebuyOffer, undefined);
  assert.equal(canBeDealtIntoHand(g.seats[0]), false);
});
test("a million purchase at a ten-thousand table locks only the selected amount once", async () => {
  const f = await fixture(); const req = await request(f, 1000000);
  const results = await Promise.all([confirmRebuy(req), confirmRebuy(req)]);
  assert.equal(results.every((r) => r.status === "accepted"), true);
  const wallet = await Wallet.findOne({ user: f.userId });
  assert.equal(wallet.balance, 1000000); assert.equal(wallet.lockedBalance, 1000000);
  assert.equal((await Lock.findOne({ user: f.userId, table: f.tableId })).amount, 1000000);
  assert.equal((await Table.findById(f.tableId)).seats[0].chips, 1000000);
  assert.equal(await Ledger.countDocuments({ userId: f.userId, type: "transfer_to_locked" }), 1);
  assert.equal((await Table.findById(f.tableId)).bigBlind, 200);
});
test("invalid amount, expired offer, cancel and missing seat never debit", async () => {
  const f = await fixture(); const req = await request(f, 10000);
  for (const amount of [9999, 1000001, 10000.5]) await assert.rejects(confirmRebuy({ ...req, amount }), /INVALID_BUYIN/);
  assert.equal((await confirmRebuy({ ...req, now: 160000 })).status, "expired");
  assert.equal((await offerRebuy(f.tableId, f.userId, 200000)).exit, true);
  const other = await fixture(); const cancelReq = await request(other, 0, { cancel: true });
  assert.equal((await confirmRebuy(cancelReq)).status, "cancelled");
  const gone = await fixture(); const goneReq = await request(gone, 10000);
  await Table.updateOne({ _id: gone.tableId }, { $set: { seats: [] } });
  await assert.rejects(confirmRebuy(goneReq), /SEAT_NOT_FOUND/);
  assert.equal(await Ledger.countDocuments({ userId: { $in: [f.userId, other.userId, gone.userId] }, type: "transfer_to_locked" }), 0);
});
test("wallet below minimum exits; amount exceeding wallet rolls back all writes", async () => {
  const poor = await fixture({ balance: 9999 });
  assert.equal((await offerRebuy(poor.tableId, poor.userId)).exit, true);
  const f = await fixture({ balance: 20000 }); const req = await request(f, 30000);
  await assert.rejects(confirmRebuy(req), /INSUFFICIENT_BALANCE/);
  assert.equal((await Table.findById(f.tableId)).seats[0].rebuyOffer.status, "pending");
  assert.equal((await Wallet.findOne({ user: f.userId })).balance, 20000);
  await Wallet.updateOne({ user: f.userId }, { $set: { balance: 9999 } });
  assert.equal((await confirmRebuy({ ...req, amount: 10000 })).exit, true);
});
test("ten billion remains exact in wallet, ledger, lock and chair; private cash limits persist", async () => {
  const f = await fixture({ min: 10000000, max: 10000000000, balance: 20000000000 });
  await confirmRebuy(await request(f, 10000000000));
  assert.equal((await Wallet.findOne({ user: f.userId })).balance, 10000000000);
  assert.equal((await Table.findById(f.tableId)).seats[0].chips, 10000000000);
  assert.equal((await Lock.findOne({ user: f.userId, table: f.tableId })).amount, 10000000000);
  const privateCash = await fixture({ min: 12345, max: 54321, kind: "vip" });
  await confirmRebuy(await request(privateCash, 54321));
  const tournament = await fixture({ kind: "tournament" });
  assert.equal(await offerRebuy(tournament.tableId, tournament.userId), null);
});
test("all-in opens no offer until lifecycle reports the hand settled", async (t) => {
  const f = await fixture(); const doc = await Table.findById(f.tableId).lean();
  const g = new PokerTable({ in: () => ({ fetchSockets: async () => [] }) }, doc);
  t.after(() => g.disposeTimers());
  g.running = true; g.round = "river"; g.seats[0].inHand = true;
  await g.autoRebuyBustedHumans();
  assert.equal((await Table.findById(f.tableId)).seats[0].rebuyOffer?.offerId, undefined);
  g.running = false; g.round = "showdown";
  await g.autoRebuyBustedHumans();
  assert.ok((await Table.findById(f.tableId)).seats[0].rebuyOffer.offerId);
});

test("rebuy during another hand waits for the next deal and preserves settlement baseline", async (t) => {
  const f = await fixture();
  const req = await request(f, 1000000, { now: Date.now() });
  // A live offer with a real deadline, independent of the synthetic time fixtures.
  await Table.updateOne({ _id: f.tableId }, { $set: { "seats.0.rebuyOffer.expiresAt": new Date(Date.now() + 60000) } });
  const mongo = await Table.findById(f.tableId).lean();
  const g = new PokerTable({ in: () => ({ fetchSockets: async () => [] }) }, mongo);
  t.after(() => g.disposeTimers());
  g.broadcastState = async () => {};
  g.running = true; g.round = "flop"; g.handStartTotal = 20000;
  const result = await g.handleRebuy(String(f.userId), req);
  assert.equal(result.status, "accepted");
  assert.equal(g.seats[0].inHand, false);
  assert.equal(g.seats[0].playerState, "WAITING");
  assert.equal(canBeDealtIntoHand(g.seats[0]), false);
  assert.equal(g.handStartTotal, 1020000);
  assert.equal(g.seats[0].handStartChips, 1000000);
  assert.equal((await g.handleRebuy(String(f.userId), req)).duplicate, true);
  assert.equal(g.handStartTotal, 1020000);
  const { promoteWaitingToSeated } = require("../utils/poker/playerState");
  promoteWaitingToSeated(g.seats);
  assert.equal(canBeDealtIntoHand(g.seats[0]), true);
});

test("committed rebuy stays accepted when its state broadcast fails", async (t) => {
  const f = await fixture();
  const offer = await offerRebuy(f.tableId, f.userId);
  const req = { offerId: offer.offerId, actionId: "delivery-failure", amount: 650877 };
  const mongo = await Table.findById(f.tableId).lean();
  const g = new PokerTable({ in: () => ({ fetchSockets: async () => [] }) }, mongo);
  t.after(() => g.disposeTimers());
  g.running = true; g.round = "flop";
  g.broadcastState = async () => { throw new Error("network timeout"); };
  assert.equal((await g.handleRebuy(String(f.userId), req)).status, "accepted");
  assert.equal((await g.handleRebuy(String(f.userId), req)).duplicate, true);
  assert.equal((await Wallet.findOne({ user: f.userId })).balance, 2000000 - 650877);
});

test("concurrent rebuy and ordinary cash-out conserve all wallet funds", async () => {
  const { permanentLeavePokerTable } = require("../services/pokerVacateService");
  const f = await fixture(); const req = await request(f, 1000000);
  const results = await Promise.allSettled([
    confirmRebuy(req),
    permanentLeavePokerTable({ ...f, liveHandInProgress: false }),
  ]);
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[1].value.left, true);
  const wallet = await Wallet.findOne({ user: f.userId });
  assert.equal(wallet.balance, 2000000);
  assert.equal(wallet.lockedBalance, 0);
  assert.equal((await Table.findById(f.tableId)).seats.length, 0);
});

test("seeding updates live public tables in place, preserving private and other-game limits", async () => {
  const user = new mongoose.Types.ObjectId();
  const live = await Table.create({ gameType: "poker", tier: "beast", tableNumber: 4,
    smallBlind: 123, bigBlind: 246, buyIn: 10000000, minimumBet: 999,
    minBuyIn: 10000000, maxBuyIn: 10000000, tableKind: "static", status: "playing", capacity: 9,
    seats: [{ user, chips: 15000000000, seatPosition: 6 }],
    activeSettlementId: "ongoing-hand" });
  const overflow = await Table.create({ gameType: "poker", tier: "beast", tableNumber: 250,
    smallBlind: 100, bigBlind: 200, minBuyIn: 1500000, maxBuyIn: 1500000,
    tableKind: "dynamic", status: "playing", capacity: 5, seats: [{ user, chips: 999, seatPosition: 3 }] });
  const privateTable = await Table.create({ gameType: "poker", tier: "private", tableNumber: 500,
    smallBlind: 1, bigBlind: 2, minBuyIn: 123, maxBuyIn: 456,
    tableKind: "vip", isPrivate: true, owner: user, capacity: 5, seats: [] });
  const reservedPrivate = await Table.create({ gameType: "poker", tier: "beast", tableNumber: 1,
    smallBlind: 1, bigBlind: 2, minBuyIn: 123, maxBuyIn: 456,
    tableKind: "vip", isPrivate: true, owner: user, capacity: 5, seats: [] });
  const svc = require("../services/tableService");
  await svc.ensureFixedTierTables();
  const migrated = await Table.findById(live._id);
  assert.equal(migrated.maxBuyIn, 10000000000);
  assert.equal(migrated.status, "playing");
  assert.equal(migrated.activeSettlementId, "ongoing-hand");
  assert.equal(migrated.seats[0].chips, 15000000000);
  assert.equal(migrated.seats[0].seatPosition, 6);
  assert.equal(migrated.bigBlind, 246);
  assert.equal(migrated.minimumBet, 999);
  assert.equal((await Table.findById(overflow._id)).maxBuyIn, 1000000000);
  assert.equal((await Table.findById(privateTable._id)).maxBuyIn, 456);
  assert.equal((await Table.findById(reservedPrivate._id)).maxBuyIn, 456);
  for (const gameType of ["trix", "tarneeb41"]) {
    const tables = await Table.find({ gameType });
    assert.ok(tables.length > 0);
    for (const table of tables) assert.equal(table.minBuyIn, table.maxBuyIn);
  }
  const five = await Table.findOne({ gameType: "poker", tier: "beast", tableNumber: 104 });
  assert.equal(five.maxBuyIn, 10000000000);
  assert.equal(five.capacity, 5);
});

test("a stale seat refresh cannot overwrite a confirmed rebuy", async (t) => {
  const f = await fixture();
  const doc = await Table.findById(f.tableId).lean();
  const g = new PokerTable({ in: () => ({ fetchSockets: async () => [] }) }, doc);
  t.after(() => g.disposeTimers());
  let resolveRead;
  const staleRead = new Promise((resolve) => { resolveRead = resolve; });
  t.mock.method(Table, "findById", () => ({ populate: () => staleRead }));
  const refresh = g.refreshSeatsFromDb();
  g.seats[0].chips = 1000000;
  g._rebuyRevision = 1;
  resolveRead(doc);
  assert.equal(await refresh, false);
  assert.equal(g.seats[0].chips, 1000000);
});

test("expiry releases the waiting chair while the other player's hand continues", async (t) => {
  const f = await fixture();
  const offer = await offerRebuy(f.tableId, f.userId, Date.now() - 60001);
  const other = new mongoose.Types.ObjectId();
  await Table.updateOne({ _id: f.tableId }, { $push: { seats: { user: other, chips: 10000, seatPosition: 7 } } });
  const doc = await Table.findById(f.tableId).lean();
  const g = new PokerTable({ in: () => ({ fetchSockets: async () => [] }) }, doc);
  g.disposeTimers();
  t.after(() => g.disposeTimers());
  g.broadcastState = async () => {};
  g.running = true; g.round = "flop"; g.currentIndex = 1; g.dealerIndex = 1;
  Object.assign(g.seats[1], { inHand: true, hole: ["As", "Ah"], playerState: "ACTIVE_HAND" });
  const result = await g.handleRebuy(String(f.userId), { offerId: offer.offerId, actionId: `expired:${offer.offerId}`, amount: 0 });
  assert.equal(result.status, "expired");
  assert.equal((await Table.findById(f.tableId)).seats.length, 1);
  assert.equal(g.findSeatIndexByUser(String(f.userId)), -1);
  assert.equal(g.running, true);
  assert.equal(g.round, "flop");
  assert.equal(g.seats[g.currentIndex].userId, String(other));
  assert.deepEqual(g.seats[g.currentIndex].hole, ["As", "Ah"]);
});

test("a superseded owner's rebuy cannot debit after ownership moves", async () => {
  const f = await fixture(); const req = await request(f, 10000);
  await Table.updateOne({ _id: f.tableId }, { $set: { pokerOwnerFence: 2 } });
  await assert.rejects(confirmRebuy({ ...req, ownerFence: 1 }), /POKER_FENCE_LOST/);
  assert.equal((await Wallet.findOne({ user: f.userId })).balance, 2000000);
});

test("rebuy after a local registry restart uses a durable fence and debits once", async (t) => {
  const f = await fixture();
  await Table.updateOne({ _id: f.tableId }, { $set: { pokerOwnerFence: 40 } });
  const nsp = { in: () => ({ fetchSockets: async () => [] }) };
  // Keep this test focused on registry ownership and the real rebuy transaction.
  t.mock.method(PokerTable.prototype, "bootstrapLobbyStart", async () => {});
  t.mock.method(PokerTable.prototype, "applyCosmeticsToSeats", async () => {});
  const firstRegistry = new GameRegistry(nsp);
  const first = await firstRegistry.get(f.tableId);
  t.after(() => first.disposeTimers());
  assert.equal(first.ownershipFence, 41);
  first.disposeTimers();
  const restartedRegistry = new GameRegistry(nsp);
  const current = await restartedRegistry.get(f.tableId);
  t.after(() => current.disposeTimers());
  assert.equal(current.ownershipFence, 42);
  const offer = await offerRebuy(f.tableId, f.userId);
  const payload = { offerId: offer.offerId, actionId: "restart-rebuy", amount: 545821 };
  first.running = current.running = true;
  current.broadcastState = async () => {};
  const stale = await first.handleRebuy(String(f.userId), payload);
  assert.equal(stale.reason, "POKER_FENCE_LOST");
  assert.equal((await Wallet.findOne({ user: f.userId })).balance, 2000000);
  assert.equal((await current.handleRebuy(String(f.userId), payload)).status, "accepted");
  assert.equal((await current.handleRebuy(String(f.userId), payload)).duplicate, true);
  assert.equal((await Wallet.findOne({ user: f.userId })).balance, 2000000 - 545821);
  assert.equal(await Ledger.countDocuments({ userId: f.userId, type: "transfer_to_locked" }), 1);
});
