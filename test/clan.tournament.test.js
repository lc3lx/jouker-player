"use strict";

/**
 * Clan tournaments — bracket generation, advancement, byes, and the money path:
 * entry-fee escrow on register, prize distribution on finish, coin conservation
 * (payouts == escrow), and full refunds on cancel/unregister.
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
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

const clanService = require("../services/clanService");
const membership = require("../services/clanMembershipService");
const engine = require("../services/clanTournamentEngineService");

let replSet = null;
const savedEnv = {};

async function makeUser(name, balance = 0) {
  const userId = new mongoose.Types.ObjectId();
  await User.create({ _id: userId, name, email: `${userId}@test.io`, password: "secret123" });
  await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return userId;
}
const balanceOf = async (u) => (await Wallet.findOne({ user: u }).lean())?.balance ?? 0;

async function makeClanWith(tag, memberCount, memberBalance) {
  const settings = await ClanSettings.getDefaults();
  const owner = await makeUser("Owner", settings.creationCost + memberBalance);
  const clan = await clanService.createClan(owner, { name: tag + " Clan", tag });
  const members = [owner];
  for (let i = 1; i < memberCount; i++) {
    const u = await makeUser("M" + i, memberBalance);
    await membership.joinClan(u, clan.id);
    members.push(u);
  }
  return { clanId: clan.id, owner, members };
}

async function playToWinner(tid, championIndex, members) {
  // Report every live match, always advancing the lower player index toward the
  // championIndex where possible so we get a deterministic champion.
  const championId = String(members[championIndex]);
  let guard = 0;
  // Keep resolving until the tournament finishes.
  // eslint-disable-next-line no-constant-condition
  while (guard++ < 50) {
    const t = await ClanTournament.findById(tid).lean();
    if (t.lifecycle === "finished" || t.lifecycle === "cancelled") break;
    const live = await ClanTournamentMatch.find({ tournament: tid, status: "live", advanced: false }).lean();
    if (!live.length) break;
    for (const m of live) {
      const players = m.players.map(String);
      const winner = players.includes(championId) ? championId : players[0];
      await engine.reportMatchResult(m._id, winner);
    }
  }
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
  await mongoose.connect(replSet.getUri(), { dbName: "clan_tournament_test" });
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
    mongoose.connection.collection("tables").deleteMany({}).catch(() => {}),
  ]);
  clanService.invalidateSettingsCache();
});

test("paid 4-player bracket: escrow, advancement, reconciled payout, coin conservation", async () => {
  const FEE = 100_000;
  const { clanId, owner, members } = await makeClanWith("PTR", 4, 1_000_000);

  const t = await engine.createTournament(owner, clanId, {
    game: "poker",
    type: "paid",
    entryFee: FEE,
    maxPlayers: 4,
    minPlayers: 2,
  });

  const balBefore = {};
  for (const m of members) {
    await engine.register(m, t.id);
    balBefore[String(m)] = await balanceOf(m);
  }

  const doc = await ClanTournament.findById(t.id).lean();
  assert.equal(doc.escrowHeld, FEE * 4, "escrow = sum of entry fees");
  assert.equal(doc.prizePool, FEE * 4);

  await engine.startTournament(t.id);
  await playToWinner(t.id, 0, members); // members[0] (the owner) wins

  const finished = await ClanTournament.findById(t.id).lean();
  assert.equal(finished.lifecycle, "finished");
  // default 4-player split: 70/30
  assert.equal(finished.prizePaid, FEE * 4, "all prize money paid out");
  assert.equal(finished.winners.length, 2);

  const champPrize = Math.floor(FEE * 4 * 0.7);
  const runnerPrize = FEE * 4 - champPrize;
  assert.equal(await balanceOf(members[0]), balBefore[String(members[0])] + champPrize);

  // Coin conservation: total delta across all four players == 0.
  let totalDelta = 0;
  for (const m of members) {
    // each paid FEE (already reflected in balBefore) then possibly received a prize
    totalDelta += (await balanceOf(m)) - (balBefore[String(m)] + 0);
  }
  // players who won got +prize; total prizes == escrow == 4*FEE
  assert.equal(totalDelta, FEE * 4, "sum of prize credits equals the escrow");
  void runnerPrize;
});

test("bye: 3-player tournament completes (odd field auto-advances a bye)", async () => {
  const FEE = 50_000;
  const { clanId, owner, members } = await makeClanWith("BYE", 3, 1_000_000);
  const t = await engine.createTournament(owner, clanId, {
    game: "trix",
    type: "paid",
    entryFee: FEE,
    maxPlayers: 4,
    minPlayers: 2,
  });
  for (const m of members) await engine.register(m, t.id);
  await engine.startTournament(t.id);
  await playToWinner(t.id, 0, members);
  const finished = await ClanTournament.findById(t.id).lean();
  assert.equal(finished.lifecycle, "finished");
  assert.equal(finished.winners[0].place, 1);
});

test("cancel refunds all escrow and closes the tournament", async () => {
  const FEE = 100_000;
  const { clanId, owner, members } = await makeClanWith("CAN", 2, 1_000_000);
  const t = await engine.createTournament(owner, clanId, {
    game: "tarneeb41",
    type: "paid",
    entryFee: FEE,
    maxPlayers: 4,
  });
  for (const m of members) await engine.register(m, t.id);
  const before = {};
  for (const m of members) before[String(m)] = await balanceOf(m);

  await engine.cancelTournament(owner, t.id);
  const doc = await ClanTournament.findById(t.id).lean();
  assert.equal(doc.lifecycle, "cancelled");
  for (const m of members) {
    assert.equal(await balanceOf(m), before[String(m)] + FEE, "entry fee refunded");
  }
});

test("unregister before start refunds the entry fee", async () => {
  const FEE = 100_000;
  const { clanId, owner, members } = await makeClanWith("UNR", 2, 1_000_000);
  const t = await engine.createTournament(owner, clanId, { game: "poker", type: "paid", entryFee: FEE, maxPlayers: 4 });
  await engine.register(members[1], t.id);
  const before = await balanceOf(members[1]);
  const res = await engine.unregister(members[1], t.id);
  assert.equal(res.refunded, FEE);
  assert.equal(await balanceOf(members[1]), before + FEE);
  const doc = await ClanTournament.findById(t.id).lean();
  assert.equal(doc.participants.length, 0);
  assert.equal(doc.escrowHeld, 0);
});

test("non-members cannot register", async () => {
  const { clanId, owner } = await makeClanWith("NMR", 1, 1_000_000);
  const outsider = await makeUser("Out", 1_000_000);
  const t = await engine.createTournament(owner, clanId, { game: "poker", type: "friendly", maxPlayers: 4 });
  await assert.rejects(() => engine.register(outsider, t.id), (e) => e.statusCode === 403);
});
