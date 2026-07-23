"use strict";

/**
 * CLAN PRODUCTION AUDIT (part 2) — state integrity, recovery and ordering.
 *
 *   • ownership transfer under concurrency (never two owners, never zero)
 *   • tournament rollback safety (failed payout must not strand or half-pay)
 *   • crash/replay recovery of a settled tournament
 *   • admin override audit trail
 *   • notification de-duplication
 *   • chat ordering under rapid sends
 *   • leaderboard consistency (no banned/deleted clans, accurate counts)
 *   • /clan socket connect + reconnect room joining
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Wallet = require("../models/walletModel");
const User = require("../models/userModel");
const Clan = require("../models/clanModel");
const ClanMember = require("../models/clanMemberModel");
const ClanSettings = require("../models/clanSettingsModel");
const ClanTournament = require("../models/clanTournamentModel");
const ClanTournamentMatch = require("../models/clanTournamentMatchModel");
const ClanTreasuryTransaction = require("../models/clanTreasuryTransactionModel");
const ChatMessage = require("../models/chatMessageModel");
const Notification = require("../models/notificationModel");
const AuditLog = require("../models/auditLogModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

const clanService = require("../services/clanService");
const membership = require("../services/clanMembershipService");
const treasury = require("../services/clanTreasuryService");
const engine = require("../services/clanTournamentEngineService");
const leaderboard = require("../services/clanLeaderboardService");
const chatService = require("../services/chatService");
const notificationService = require("../services/notificationService");
const admin = require("../services/clanAdminService");

let replSet = null;
const savedEnv = {};
const ADMIN_ID = new mongoose.Types.ObjectId();

async function makeUser(name, balance = 0) {
  const userId = new mongoose.Types.ObjectId();
  await User.create({ _id: userId, name, email: `${userId}@test.io`, password: "secret123" });
  await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return userId;
}
async function totalWalletCoins() {
  const rows = await Wallet.aggregate([{ $group: { _id: null, t: { $sum: "$balance" } } }]);
  return rows[0]?.t || 0;
}
async function makeClan(tag, ownerBalance = 0) {
  const settings = await ClanSettings.getDefaults();
  const owner = await makeUser("Owner", settings.creationCost + ownerBalance);
  const clan = await clanService.createClan(owner, { name: `${tag} Clan`, tag });
  return { owner, clanId: clan.id };
}
function mkReq({ params = {}, body = {}, query = {} } = {}) {
  return { params, body, query, user: { _id: ADMIN_ID }, ip: "127.0.0.1", get: () => "test" };
}
async function runAdmin(handler, req) {
  const res = {
    statusCode: 200,
    payload: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
  };
  let err = null;
  await handler(req, res, (e) => { err = e; });
  if (err) throw err;
  return res;
}

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE"]) savedEnv[k] = process.env[k];
  delete process.env.MONGO_STANDALONE;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "clan_audit2_test" });
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  resetMongoTransactionProbeForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test.beforeEach(async () => {
  await Promise.all([
    Clan.deleteMany({}), ClanMember.deleteMany({}), Wallet.deleteMany({}), User.deleteMany({}),
    ClanSettings.deleteMany({}), ClanTournament.deleteMany({}), ClanTournamentMatch.deleteMany({}),
    ClanTreasuryTransaction.deleteMany({}), ChatMessage.deleteMany({}), Notification.deleteMany({}),
    AuditLog.deleteMany({}),
  ]);
  clanService.invalidateSettingsCache();
});

// ══ OWNERSHIP TRANSFER ════════════════════════════════════════════════════════

test("AUDIT: concurrent ownership transfers leave exactly one owner", async () => {
  const { owner, clanId } = await makeClan("OWN");
  const heirs = [];
  for (let i = 0; i < 5; i++) {
    const u = await makeUser(`H${i}`);
    await membership.joinClan(u, clanId);
    heirs.push(u);
  }

  // The owner fires transfers to five different members at once.
  await Promise.allSettled(heirs.map((h) => membership.transferOwnership(owner, clanId, h)));

  const owners = await ClanMember.find({ clan: clanId, role: "owner" }).lean();
  assert.equal(owners.length, 1, `exactly one owner role (got ${owners.length})`);

  const clan = await Clan.findById(clanId).lean();
  assert.equal(
    String(clan.owner),
    String(owners[0].user),
    "clan.owner matches the single owner-role member"
  );

  // The previous owner must have been demoted, not left as a second owner.
  const prev = await ClanMember.findOne({ clan: clanId, user: owner }).lean();
  if (String(clan.owner) !== String(owner)) {
    assert.notEqual(prev.role, "owner", "old owner demoted");
  }
});

test("AUDIT: a non-owner can never win a transfer race", async () => {
  const { owner, clanId } = await makeClan("NOW");
  const a = await makeUser("A");
  const b = await makeUser("B");
  await membership.joinClan(a, clanId);
  await membership.joinClan(b, clanId);

  await Promise.allSettled([
    membership.transferOwnership(a, clanId, b), // a is not the owner
    membership.transferOwnership(b, clanId, a), // nor is b
  ]);

  const clan = await Clan.findById(clanId).lean();
  assert.equal(String(clan.owner), String(owner), "ownership unchanged by non-owners");
  const owners = await ClanMember.find({ clan: clanId, role: "owner" }).lean();
  assert.equal(owners.length, 1);
});

// ══ TOURNAMENT ROLLBACK / RECOVERY ════════════════════════════════════════════

test("AUDIT: a failed payout rolls back and pays nothing", async () => {
  const FEE = 100_000;
  const { clanId, owner } = await makeClan("RBK", 1_000_000);
  const members = [owner];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(`B${i}`, 1_000_000);
    await membership.joinClan(u, clanId);
    members.push(u);
  }
  const t = await engine.createTournament(owner, clanId, {
    game: "poker", type: "paid", entryFee: FEE, maxPlayers: 4,
  });
  for (const m of members) await engine.register(m, t.id);
  await engine.startTournament(t.id);

  // Corrupt the escrow so reconciliation must reject the payout.
  await ClanTournament.updateOne({ _id: t.id }, { $set: { escrowHeld: 1 } });

  const before = await totalWalletCoins();
  await assert.rejects(() => engine.finishTournament(t.id, members[0]));

  assert.equal(await totalWalletCoins(), before, "no coins moved on a rejected payout");
  const doc = await ClanTournament.findById(t.id).lean();
  assert.notEqual(doc.lifecycle, "finished", "lifecycle rolled back, not stranded as finished");
  assert.equal(doc.prizePaid, 0, "nothing recorded as paid");
});

test("AUDIT: a settled tournament replays as a no-op (crash recovery)", async () => {
  const FEE = 60_000;
  const { clanId, owner } = await makeClan("RCV", 1_000_000);
  const members = [owner];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(`V${i}`, 1_000_000);
    await membership.joinClan(u, clanId);
    members.push(u);
  }
  const t = await engine.createTournament(owner, clanId, {
    game: "poker", type: "paid", entryFee: FEE, maxPlayers: 4,
  });
  for (const m of members) await engine.register(m, t.id);
  await engine.startTournament(t.id);
  await engine.finishTournament(t.id, members[0]);

  const afterSettle = await totalWalletCoins();
  const paid = (await ClanTournament.findById(t.id).lean()).prizePaid;

  // Simulate the engine ticker / a restarted process replaying the settlement.
  await engine.finishTournament(t.id, members[0]);
  await engine.tick();
  await engine.finishTournament(t.id, members[0]);

  assert.equal(await totalWalletCoins(), afterSettle, "replay pays nothing extra");
  assert.equal((await ClanTournament.findById(t.id).lean()).prizePaid, paid, "prizePaid unchanged");
});

test("AUDIT: the walkover ticker cannot double-resolve an already reported match", async () => {
  const FEE = 25_000;
  const { clanId, owner } = await makeClan("WLK", 1_000_000);
  const members = [owner];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(`W${i}`, 1_000_000);
    await membership.joinClan(u, clanId);
    members.push(u);
  }
  const t = await engine.createTournament(owner, clanId, {
    game: "poker", type: "paid", entryFee: FEE, maxPlayers: 4,
  });
  for (const m of members) await engine.register(m, t.id);
  await engine.startTournament(t.id);

  // Force every live match past its deadline, then race a real report vs the tick.
  await ClanTournamentMatch.updateMany(
    { tournament: t.id, status: "live" },
    { $set: { deadlineAt: new Date(Date.now() - 60_000) } }
  );
  const m1 = await ClanTournamentMatch.findOne({ tournament: t.id, advanced: false }).lean();

  await Promise.allSettled([
    engine.reportMatchResult(m1._id, m1.players[1]),
    engine.tick(),
    engine.tick(),
  ]);

  const resolved = await ClanTournamentMatch.findById(m1._id).lean();
  assert.equal(resolved.advanced, true);
  // Whoever won, the next-round slot must hold that winner exactly once.
  const next = await ClanTournamentMatch.findOne({ tournament: t.id, round: 2 }).lean();
  if (next) {
    const dupes = next.players.filter((p) => String(p) === String(resolved.winner)).length;
    assert.equal(dupes, 1, "winner advanced exactly once despite the ticker race");
  }
});

// ══ ADMIN AUDIT TRAIL ═════════════════════════════════════════════════════════

test("AUDIT: every admin override writes an audit-log entry", async () => {
  const { owner, clanId } = await makeClan("ADT");
  const heir = await makeUser("Heir");
  await membership.joinClan(heir, clanId);

  await runAdmin(admin.adminBanClan, mkReq({ params: { id: clanId }, body: { reason: "x" } }));
  await runAdmin(admin.adminRestoreClan, mkReq({ params: { id: clanId } }));
  await runAdmin(admin.adminUpdateConfig, mkReq({ body: { creationCost: 999 } }));
  await runAdmin(admin.adminAdjustTreasury, mkReq({ params: { id: clanId }, body: { amount: 500, direction: "in" } }));
  await runAdmin(admin.adminTransferOwnership, mkReq({ params: { id: clanId }, body: { userId: String(heir) } }));

  // Audit writes are fire-and-forget; allow them to land.
  await new Promise((r) => setTimeout(r, 250));

  const events = await AuditLog.find({}).lean();
  const names = events.map((e) => e.event);
  for (const expected of [
    "admin_clan_ban",
    "admin_clan_restore",
    "admin_clan_config_update",
    "admin_clan_treasury_adjust",
    "admin_clan_transfer",
  ]) {
    assert.ok(names.includes(expected), `audit entry recorded for ${expected}`);
  }
  // Every entry must attribute the acting admin.
  for (const e of events) {
    assert.equal(String(e.actor), String(ADMIN_ID), `${e.event} attributed to the admin`);
  }
  void owner;
});

// ══ NOTIFICATIONS ═════════════════════════════════════════════════════════════

test("AUDIT: notifications de-duplicate on (sourceType, sourceId)", async () => {
  const uid = await makeUser("Notified");
  await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      notificationService.createNotification({
        userId: uid,
        category: "clan",
        title: "دعوة",
        sourceType: "clan_invitation",
        sourceId: "same-source-id",
      })
    )
  );
  const count = await Notification.countDocuments({ userId: uid, sourceType: "clan_invitation" });
  assert.equal(count, 1, `exactly one notification for a repeated source (got ${count})`);
});

test("AUDIT: clan notifications are ordered newest-first by createdAt", async () => {
  const uid = await makeUser("Ordered");
  for (let i = 0; i < 5; i++) {
    await notificationService.createNotification({
      userId: uid,
      category: "clan",
      title: `event-${i}`,
      sourceType: "clan_test",
      sourceId: `s${i}`,
    });
    await new Promise((r) => setTimeout(r, 5));
  }
  const rows = await Notification.find({ userId: uid }).sort({ createdAt: -1 }).lean();
  assert.equal(rows.length, 5);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i - 1].createdAt >= rows[i].createdAt,
      "notifications are monotonically ordered"
    );
  }
  assert.equal(rows[0].title, "event-4", "newest first");
});

// ══ CHAT ORDERING ═════════════════════════════════════════════════════════════

test("AUDIT: clan chat history preserves send order under rapid sends", async () => {
  const { owner, clanId } = await makeClan("ORD");

  // 40 rapid sequential sends — many will share the same millisecond.
  for (let i = 0; i < 40; i++) {
    await chatService.sendMessage({
      senderId: owner,
      channel: "clan",
      channelId: clanId,
      body: `msg-${String(i).padStart(2, "0")}`,
    });
  }

  const history = await chatService.getHistory({ channel: "clan", channelId: clanId, limit: 100 });
  assert.equal(history.length, 40, "all messages returned");
  const bodies = history.map((m) => m.body);
  const expected = Array.from({ length: 40 }, (_, i) => `msg-${String(i).padStart(2, "0")}`);
  assert.deepEqual(bodies, expected, "history is in true send order");
});

// ══ LEADERBOARD CONSISTENCY ═══════════════════════════════════════════════════

test("AUDIT: leaderboards exclude banned and deleted clans", async () => {
  const active = await makeClan("LBA");
  const banned = await makeClan("LBB");
  const deleted = await makeClan("LBD");
  await Clan.updateOne({ _id: active.clanId }, { $set: { "stats.rankScore": 10 } });
  await Clan.updateOne({ _id: banned.clanId }, { $set: { "stats.rankScore": 9999, status: "banned" } });
  await Clan.updateOne({ _id: deleted.clanId }, { $set: { "stats.rankScore": 8888, status: "deleted" } });

  for (const scope of ["global", "weekly", "monthly", "most_active", "most_tournament_wins"]) {
    const board = await leaderboard.getLeaderboard({ scope });
    const ids = board.data.map((r) => r.id);
    assert.ok(!ids.includes(banned.clanId), `${scope}: banned clan excluded`);
    assert.ok(!ids.includes(deleted.clanId), `${scope}: deleted clan excluded`);
    assert.ok(ids.includes(active.clanId), `${scope}: active clan present`);
  }
});

test("AUDIT: leaderboard ranks are contiguous and correctly ordered", async () => {
  const clans = [];
  for (let i = 0; i < 12; i++) {
    const c = await makeClan(`LR${i}`);
    await Clan.updateOne({ _id: c.clanId }, { $set: { "stats.rankScore": i * 10 } });
    clans.push(c.clanId);
  }
  const board = await leaderboard.getLeaderboard({ scope: "global", limit: 100 });
  assert.equal(board.data.length, 12);
  for (let i = 0; i < board.data.length; i++) {
    assert.equal(board.data[i].rank, i + 1, "ranks are contiguous from 1");
    if (i > 0) {
      assert.ok(
        board.data[i - 1].metric >= board.data[i].metric,
        "descending by metric"
      );
    }
  }
});

test("AUDIT: memberCount stays consistent with reality after churn", async () => {
  const { clanId } = await makeClan("CHR");
  await Clan.updateOne({ _id: clanId }, { $set: { maxMembers: 100 } });
  const users = [];
  for (let i = 0; i < 40; i++) users.push(await makeUser(`C${i}`));

  await Promise.allSettled(users.map((u) => membership.joinClan(u, clanId)));
  await Promise.allSettled(users.slice(0, 20).map((u) => membership.leaveClan(u)));

  const clan = await Clan.findById(clanId).lean();
  const real = await ClanMember.countDocuments({ clan: clanId });
  assert.equal(clan.memberCount, real, "denormalized count matches ClanMember rows");

  const board = await leaderboard.getLeaderboard({ scope: "global" });
  const row = board.data.find((r) => r.id === clanId);
  assert.equal(row.memberCount, real, "leaderboard reports the true member count");
});

// ══ SOCKET CONNECT / RECONNECT ════════════════════════════════════════════════

test("AUDIT: /clan socket joins the right rooms on connect and reconnect", async () => {
  const { owner, clanId } = await makeClan("SCK");

  const handlers = {};
  const nsp = {
    use() {},
    on(ev, fn) { handlers[ev] = fn; },
    to() { return { emit() {} }; },
  };
  const { initClan } = require("../sockets/clan");
  initClan({ of: () => nsp });

  function fakeSocket(userId) {
    const joined = [];
    const events = {};
    return {
      userId: String(userId),
      data: {},
      joined,
      emitted: [],
      join: (room) => joined.push(room),
      emit: (ev, payload) => events[ev] = payload,
      on: (ev, fn) => { events[ev] = fn; },
      handler: (ev) => events[ev],
      events,
    };
  }

  // Member connects → joins personal + clan + clan-chat rooms.
  const s1 = fakeSocket(owner);
  await handlers.connection(s1);
  assert.ok(s1.joined.includes(`user:${String(owner)}`), "joined personal room");
  assert.ok(s1.joined.includes(`clan:${clanId}`), "joined clan room");
  assert.ok(s1.joined.some((r) => r.startsWith("chat:clan:")), "joined clan chat room");

  // Reconnect (a fresh socket for the same user) must re-join identically —
  // this is what makes reconnects transparent.
  const s2 = fakeSocket(owner);
  await handlers.connection(s2);
  assert.deepEqual(s2.joined.sort(), s1.joined.sort(), "reconnect restores the same rooms");

  // A clanless user connects without error and joins no clan room.
  const loner = await makeUser("Loner");
  const s3 = fakeSocket(loner);
  await handlers.connection(s3);
  assert.ok(s3.joined.includes(`user:${String(loner)}`));
  assert.ok(!s3.joined.some((r) => r.startsWith("clan:")), "clanless user joins no clan room");
});

test("AUDIT: socket chat:join refuses a clan the user is not a member of", async () => {
  const { clanId } = await makeClan("SJN");
  const outsider = await makeUser("Outsider");

  const handlers = {};
  const nsp = { use() {}, on(ev, fn) { handlers[ev] = fn; }, to() { return { emit() {} }; } };
  const { initClan } = require("../sockets/clan");
  initClan({ of: () => nsp });

  const socketHandlers = {};
  const joined = [];
  const socket = {
    userId: String(outsider),
    data: {},
    join: (r) => joined.push(r),
    emit: () => {},
    on: (ev, fn) => { socketHandlers[ev] = fn; },
  };
  await handlers.connection(socket);

  joined.length = 0;
  await socketHandlers["clan:chat:join"]({ clanId });
  assert.equal(joined.length, 0, "non-member was not joined to the clan rooms");
});
