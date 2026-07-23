"use strict";

/**
 * CLAN PRODUCTION AUDIT — concurrency, idempotency and conservation.
 *
 * Every test here asserts a money or state invariant under concurrent load:
 *   • coins are never duplicated or destroyed unexpectedly
 *   • a tournament prize is paid at most once
 *   • escrow refunds happen at most once
 *   • treasury never goes negative or drifts from its ledger
 *   • capacity limits (clan members, tournament seats) are never exceeded
 *   • one-clan-per-player holds under concurrent joins/invites
 *
 * Runs on a real Mongo replica set so wallet transactions are genuine.
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
const ClanInvitation = require("../models/clanInvitationModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

const clanService = require("../services/clanService");
const membership = require("../services/clanMembershipService");
const invitations = require("../services/clanInvitationService");
const treasury = require("../services/clanTreasuryService");
const engine = require("../services/clanTournamentEngineService");

let replSet = null;
const savedEnv = {};

// ─── helpers ──────────────────────────────────────────────────────────────────
async function makeUser(name, balance = 0) {
  const userId = new mongoose.Types.ObjectId();
  await User.create({ _id: userId, name, email: `${userId}@test.io`, password: "secret123" });
  await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return userId;
}
const balanceOf = async (u) => (await Wallet.findOne({ user: u }).lean())?.balance ?? 0;
const treasuryOf = async (c) => (await Clan.findById(c).lean())?.treasury?.balance ?? 0;

/** Total coins sitting in player wallets — the conservation yardstick. */
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

/** Register members and play a paid tournament down to (but not including) the final. */
async function buildTournamentToFinal({ clanId, owner, members, fee }) {
  const t = await engine.createTournament(owner, clanId, {
    game: "poker",
    type: "paid",
    entryFee: fee,
    maxPlayers: 4,
    minPlayers: 2,
  });
  for (const m of members) await engine.register(m, t.id);
  await engine.startTournament(t.id);

  // Resolve round 1 only, leaving the final pending.
  const r1 = await ClanTournamentMatch.find({ tournament: t.id, round: 1 }).lean();
  for (const m of r1) {
    if (!m.advanced && m.players.length === 2) {
      await engine.reportMatchResult(m._id, m.players[0]);
    }
  }
  const finalMatch = await ClanTournamentMatch.findOne({
    tournament: t.id,
    round: 2,
    advanced: false,
  }).lean();
  return { tournamentId: t.id, finalMatch };
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
  await mongoose.connect(replSet.getUri(), { dbName: "clan_audit_test" });
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
    Clan.deleteMany({}),
    ClanMember.deleteMany({}),
    Wallet.deleteMany({}),
    User.deleteMany({}),
    ClanSettings.deleteMany({}),
    ClanTournament.deleteMany({}),
    ClanTournamentMatch.deleteMany({}),
    ClanTreasuryTransaction.deleteMany({}),
    ClanInvitation.deleteMany({}),
  ]);
  clanService.invalidateSettingsCache();
});

// ══ 1. TOURNAMENT PAYOUT — no double spend ════════════════════════════════════

test("AUDIT: concurrent final-match reports pay the prize exactly once", async () => {
  const FEE = 100_000;
  const { clanId, owner } = await makeClan("DBL", 1_000_000);
  const members = [owner];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(`P${i}`, 1_000_000);
    await membership.joinClan(u, clanId);
    members.push(u);
  }

  const { tournamentId, finalMatch } = await buildTournamentToFinal({
    clanId,
    owner,
    members,
    fee: FEE,
  });
  assert.ok(finalMatch, "final match exists");

  const walletsBeforeFinal = await totalWalletCoins();
  const prizePool = (await ClanTournament.findById(tournamentId).lean()).prizePool;

  // Fire the SAME final result 5× concurrently (simulates duplicate settlement
  // callbacks / retries / double-clicks).
  const winner = finalMatch.players[0];
  await Promise.allSettled(
    Array.from({ length: 5 }, () => engine.reportMatchResult(finalMatch._id, winner))
  );

  const walletsAfter = await totalWalletCoins();
  const doc = await ClanTournament.findById(tournamentId).lean();

  assert.equal(
    walletsAfter - walletsBeforeFinal,
    prizePool,
    `prize paid exactly once (expected +${prizePool}, got +${walletsAfter - walletsBeforeFinal})`
  );
  assert.equal(doc.prizePaid, prizePool, "prizePaid equals the pool, not a multiple");
  assert.equal(doc.lifecycle, "finished");
});

test("AUDIT: concurrent finishTournament calls cannot double-pay", async () => {
  const FEE = 50_000;
  const { clanId, owner } = await makeClan("FIN", 1_000_000);
  const members = [owner];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(`F${i}`, 1_000_000);
    await membership.joinClan(u, clanId);
    members.push(u);
  }
  const t = await engine.createTournament(owner, clanId, {
    game: "poker",
    type: "paid",
    entryFee: FEE,
    maxPlayers: 4,
  });
  for (const m of members) await engine.register(m, t.id);
  await engine.startTournament(t.id);

  const before = await totalWalletCoins();
  const prizePool = (await ClanTournament.findById(t.id).lean()).prizePool;

  // Hammer finishTournament directly — the last line of defence.
  await Promise.allSettled(
    Array.from({ length: 6 }, () => engine.finishTournament(t.id, members[0]))
  );

  const after = await totalWalletCoins();
  assert.equal(after - before, prizePool, "prize pool paid exactly once");
  const doc = await ClanTournament.findById(t.id).lean();
  assert.equal(doc.prizePaid, prizePool);
});

// ══ 2. CANCEL / REFUND — no double refund ═════════════════════════════════════

test("AUDIT: concurrent tournament cancels refund each entry exactly once", async () => {
  const FEE = 100_000;
  const { clanId, owner } = await makeClan("CAN", 1_000_000);
  const members = [owner];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(`C${i}`, 1_000_000);
    await membership.joinClan(u, clanId);
    members.push(u);
  }
  const t = await engine.createTournament(owner, clanId, {
    game: "trix",
    type: "paid",
    entryFee: FEE,
    maxPlayers: 4,
  });
  for (const m of members) await engine.register(m, t.id);

  const afterRegister = await totalWalletCoins();

  await Promise.allSettled(
    Array.from({ length: 6 }, () => engine.cancelTournament(owner, t.id, "stress"))
  );

  const afterCancel = await totalWalletCoins();
  assert.equal(
    afterCancel - afterRegister,
    FEE * members.length,
    "each entry refunded exactly once"
  );
  const doc = await ClanTournament.findById(t.id).lean();
  assert.equal(doc.lifecycle, "cancelled");
});

test("AUDIT: a finished tournament can never also be cancelled/refunded", async () => {
  const FEE = 75_000;
  const { clanId, owner } = await makeClan("FCX", 1_000_000);
  const members = [owner];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(`X${i}`, 1_000_000);
    await membership.joinClan(u, clanId);
    members.push(u);
  }
  const t = await engine.createTournament(owner, clanId, {
    game: "poker",
    type: "paid",
    entryFee: FEE,
    maxPlayers: 4,
  });
  for (const m of members) await engine.register(m, t.id);
  await engine.startTournament(t.id);
  await engine.finishTournament(t.id, members[0]);

  const afterFinish = await totalWalletCoins();
  await Promise.allSettled([
    engine.cancelTournament(owner, t.id, "late"),
    engine.cancelTournament(owner, t.id, "late"),
  ]);
  assert.equal(await totalWalletCoins(), afterFinish, "no refund after payout");
});

// ══ 3. FULL-CYCLE COIN CONSERVATION ═══════════════════════════════════════════

test("AUDIT: a full paid tournament conserves total coins (in == out)", async () => {
  const FEE = 250_000;
  const { clanId, owner } = await makeClan("CNS", 2_000_000);
  const members = [owner];
  for (let i = 0; i < 7; i++) {
    const u = await makeUser(`N${i}`, 2_000_000);
    await membership.joinClan(u, clanId);
    members.push(u);
  }

  const before = await totalWalletCoins();

  const t = await engine.createTournament(owner, clanId, {
    game: "tarneeb41",
    type: "paid",
    entryFee: FEE,
    maxPlayers: 8,
    minPlayers: 2,
  });
  for (const m of members) await engine.register(m, t.id);
  await engine.startTournament(t.id);

  // Play every round out.
  for (let guard = 0; guard < 30; guard++) {
    const doc = await ClanTournament.findById(t.id).lean();
    if (doc.lifecycle === "finished") break;
    const live = await ClanTournamentMatch.find({
      tournament: t.id,
      advanced: false,
      players: { $size: 2 },
    }).lean();
    if (!live.length) break;
    for (const m of live) await engine.reportMatchResult(m._id, m.players[0]);
  }

  const after = await totalWalletCoins();
  assert.equal(after, before, "entry fees collected equal prizes paid — no coins created or lost");
  const doc = await ClanTournament.findById(t.id).lean();
  assert.equal(doc.lifecycle, "finished");
  assert.equal(doc.prizePaid, doc.escrowHeld, "payout reconciles to escrow");
});

// ══ 4. CONCURRENT JOINS / CAPACITY ════════════════════════════════════════════

test("AUDIT: concurrent joins never exceed maxMembers", async () => {
  const { clanId } = await makeClan("CAP");
  await Clan.updateOne({ _id: clanId }, { $set: { maxMembers: 5 } });

  const users = [];
  for (let i = 0; i < 60; i++) users.push(await makeUser(`J${i}`));

  await Promise.allSettled(users.map((u) => membership.joinClan(u, clanId)));

  const clan = await Clan.findById(clanId).lean();
  const actual = await ClanMember.countDocuments({ clan: clanId });
  assert.equal(actual, 5, `seat count capped at 5 (got ${actual})`);
  assert.equal(clan.memberCount, 5, "denormalized memberCount matches reality");
});

test("AUDIT: one player joining many clans concurrently ends in exactly one", async () => {
  const clans = [];
  for (let i = 0; i < 8; i++) {
    const c = await makeClan(`M${i}`);
    clans.push(c.clanId);
  }
  const player = await makeUser("Racer");

  await Promise.allSettled(clans.map((c) => membership.joinClan(player, c)));

  const memberships = await ClanMember.countDocuments({ user: player });
  assert.equal(memberships, 1, `exactly one membership (got ${memberships})`);

  // memberCount must not have been inflated on the clans that rejected them.
  for (const c of clans) {
    const clan = await Clan.findById(c).lean();
    const real = await ClanMember.countDocuments({ clan: c });
    assert.equal(clan.memberCount, real, `memberCount consistent for ${clan.tag}`);
  }
});

test("AUDIT: concurrent invitation accepts land the user in exactly one clan", async () => {
  const invitee = await makeUser("Invitee");
  const inviteIds = [];
  for (let i = 0; i < 6; i++) {
    const { owner, clanId } = await makeClan(`IV${i}`);
    const inv = await invitations.sendInvitation(owner, clanId, invitee);
    inviteIds.push(inv.id);
  }

  await Promise.allSettled(inviteIds.map((id) => invitations.acceptInvitation(invitee, id)));

  const memberships = await ClanMember.countDocuments({ user: invitee });
  assert.equal(memberships, 1, `exactly one membership from concurrent accepts (got ${memberships})`);

  const clans = await Clan.find({}).lean();
  for (const c of clans) {
    const real = await ClanMember.countDocuments({ clan: c._id });
    assert.equal(c.memberCount, real, `memberCount consistent for ${c.tag}`);
  }
});

// ══ 5. CONCURRENT DONATIONS / TREASURY CONSERVATION ═══════════════════════════

test("AUDIT: concurrent donations conserve coins and match the treasury ledger", async () => {
  const { clanId } = await makeClan("DON");
  await Clan.updateOne({ _id: clanId }, { $set: { maxMembers: 300 } });

  const DONATION = 10_000;
  const donors = [];
  for (let i = 0; i < 120; i++) {
    const u = await makeUser(`D${i}`, 1_000_000);
    await membership.joinClan(u, clanId);
    donors.push(u);
  }

  const walletsBefore = await totalWalletCoins();

  const results = await Promise.allSettled(
    donors.map((u) => treasury.donate(u, clanId, DONATION))
  );
  const succeeded = results.filter((r) => r.status === "fulfilled").length;

  const walletsAfter = await totalWalletCoins();
  const treasuryBal = await treasuryOf(clanId);

  assert.equal(succeeded, donors.length, "all donations succeeded");
  assert.equal(
    walletsBefore - walletsAfter,
    succeeded * DONATION,
    "wallets debited exactly the donated total"
  );
  assert.equal(treasuryBal, succeeded * DONATION, "treasury credited exactly the donated total");

  // Treasury balance must equal the sum of its own audit ledger.
  const led = await ClanTreasuryTransaction.aggregate([
    { $match: { clan: new mongoose.Types.ObjectId(clanId) } },
    {
      $group: {
        _id: null,
        t: {
          $sum: { $cond: [{ $eq: ["$direction", "in"] }, "$amount", { $multiply: ["$amount", -1] }] },
        },
      },
    },
  ]);
  assert.equal(led[0]?.t || 0, treasuryBal, "treasury balance reconciles with its ledger");
});

test("AUDIT: concurrent treasury debits never drive the balance negative", async () => {
  const { clanId } = await makeClan("NEG");
  await treasury.adminAdjust(clanId, 100_000, "in");

  // 40 concurrent debits of 10k against a 100k balance → at most 10 succeed.
  const results = await Promise.allSettled(
    Array.from({ length: 40 }, () => treasury.adminAdjust(clanId, 10_000, "out"))
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;

  const bal = await treasuryOf(clanId);
  assert.ok(bal >= 0, `treasury never negative (got ${bal})`);
  assert.equal(ok, 10, `exactly 10 debits succeeded (got ${ok})`);
  assert.equal(bal, 0, "balance fully drained but not overdrawn");
});

// ══ 6. CONCURRENT TOURNAMENT REGISTRATION ═════════════════════════════════════

test("AUDIT: concurrent registrations respect maxPlayers and escrow matches seats", async () => {
  const FEE = 20_000;
  const { clanId, owner } = await makeClan("REG", 1_000_000);
  await Clan.updateOne({ _id: clanId }, { $set: { maxMembers: 200 } });

  const players = [];
  for (let i = 0; i < 50; i++) {
    const u = await makeUser(`R${i}`, 1_000_000);
    await membership.joinClan(u, clanId);
    players.push(u);
  }

  const t = await engine.createTournament(owner, clanId, {
    game: "poker",
    type: "paid",
    entryFee: FEE,
    maxPlayers: 8,
    minPlayers: 2,
  });

  const walletsBefore = await totalWalletCoins();
  await Promise.allSettled(players.map((p) => engine.register(p, t.id)));

  const doc = await ClanTournament.findById(t.id).lean();
  const walletsAfter = await totalWalletCoins();

  assert.equal(doc.participants.length, 8, `seats capped at 8 (got ${doc.participants.length})`);
  assert.equal(doc.escrowHeld, 8 * FEE, "escrow equals seats × fee");
  assert.equal(
    walletsBefore - walletsAfter,
    8 * FEE,
    "only seated players were charged — no phantom debits"
  );
});

test("AUDIT: duplicate concurrent registration charges a player only once", async () => {
  const FEE = 30_000;
  const { clanId, owner } = await makeClan("DUP", 1_000_000);
  const player = await makeUser("Solo", 1_000_000);
  await membership.joinClan(player, clanId);

  const t = await engine.createTournament(owner, clanId, {
    game: "poker",
    type: "paid",
    entryFee: FEE,
    maxPlayers: 8,
  });

  const before = await balanceOf(player);
  await Promise.allSettled(Array.from({ length: 10 }, () => engine.register(player, t.id)));

  const doc = await ClanTournament.findById(t.id).lean();
  const seats = doc.participants.filter((p) => String(p.user) === String(player)).length;
  assert.equal(seats, 1, "registered exactly once");
  assert.equal(await balanceOf(player), before - FEE, "charged exactly one entry fee");
  assert.equal(doc.escrowHeld, FEE, "escrow reflects a single entry");
});

// ══ 7. IDEMPOTENCY ════════════════════════════════════════════════════════════

test("AUDIT: repeated reportMatchResult is idempotent (sequential replay)", async () => {
  const FEE = 40_000;
  const { clanId, owner } = await makeClan("IDM", 1_000_000);
  const members = [owner];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(`I${i}`, 1_000_000);
    await membership.joinClan(u, clanId);
    members.push(u);
  }
  const t = await engine.createTournament(owner, clanId, {
    game: "poker",
    type: "paid",
    entryFee: FEE,
    maxPlayers: 4,
  });
  for (const m of members) await engine.register(m, t.id);
  await engine.startTournament(t.id);

  const m1 = await ClanTournamentMatch.findOne({ tournament: t.id, round: 1, advanced: false }).lean();
  const winner = m1.players[0];

  const first = await engine.reportMatchResult(m1._id, winner);
  const second = await engine.reportMatchResult(m1._id, winner);
  const third = await engine.reportMatchResult(m1._id, winner);

  assert.equal(first.status, "advanced");
  assert.equal(second.status, "already_resolved", "replay is a no-op");
  assert.equal(third.status, "already_resolved");

  // The winner must appear only once in the next-round match.
  const next = await ClanTournamentMatch.findOne({ tournament: t.id, round: 2 }).lean();
  const occurrences = next.players.filter((p) => String(p) === String(winner)).length;
  assert.equal(occurrences, 1, "winner advanced exactly once");
});

// ══ 8. STRESS — hundreds of players, mixed concurrent operations ══════════════

test("AUDIT STRESS: 200 players, mixed concurrent ops, all invariants hold", async () => {
  const { clanId, owner } = await makeClan("STR", 5_000_000);
  await Clan.updateOne({ _id: clanId }, { $set: { maxMembers: 250 } });

  const players = [];
  for (let i = 0; i < 200; i++) players.push(await makeUser(`S${i}`, 500_000));

  const walletsBefore = await totalWalletCoins();

  // Everyone joins at once.
  await Promise.allSettled(players.map((p) => membership.joinClan(p, clanId)));
  const seated = await ClanMember.countDocuments({ clan: clanId });
  assert.ok(seated <= 250, "member cap respected");

  const clanAfterJoin = await Clan.findById(clanId).lean();
  assert.equal(clanAfterJoin.memberCount, seated, "memberCount consistent after mass join");

  // Half donate concurrently while the other half try to leave.
  const donors = players.slice(0, 100);
  const leavers = players.slice(100, 150);
  await Promise.allSettled([
    ...donors.map((p) => treasury.donate(p, clanId, 5_000)),
    ...leavers.map((p) => membership.leaveClan(p)),
  ]);

  const clanNow = await Clan.findById(clanId).lean();
  const realMembers = await ClanMember.countDocuments({ clan: clanId });
  assert.equal(clanNow.memberCount, realMembers, "memberCount consistent after churn");

  // Treasury reconciles with its ledger.
  const led = await ClanTreasuryTransaction.aggregate([
    { $match: { clan: new mongoose.Types.ObjectId(clanId) } },
    {
      $group: {
        _id: null,
        t: {
          $sum: { $cond: [{ $eq: ["$direction", "in"] }, "$amount", { $multiply: ["$amount", -1] }] },
        },
      },
    },
  ]);
  assert.equal(led[0]?.t || 0, clanNow.treasury.balance, "treasury reconciles under load");

  // Global conservation: coins only moved wallet → treasury.
  const walletsAfter = await totalWalletCoins();
  assert.equal(
    walletsBefore - walletsAfter,
    clanNow.treasury.balance,
    "every coin that left a wallet is accounted for in the treasury"
  );

  // No player holds two memberships.
  const dupes = await ClanMember.aggregate([
    { $group: { _id: "$user", n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  assert.equal(dupes.length, 0, "no duplicate memberships under load");
});
