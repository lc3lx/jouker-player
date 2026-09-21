"use strict";

/**
 * The house schedule ladder.
 *
 * Every tier of every game used to start on the same 2-hour boundary: the
 * lobby sat empty for two hours, then fifteen events fired at once. Now one
 * tier starts every half hour, climbing the ladder, on a 3-hour cycle that
 * divides the day evenly so the times are the same every day.
 *
 * The test that matters most here is the last one. Changing a schedule strands
 * whatever the old one seeded, and the cleanup that removes those must never
 * reach a tournament somebody has already paid to enter.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const ArenaTournament = require("../models/arenaTournamentModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");
const catalog = require("../services/arenaTournamentCatalog");
const engine = require("../services/arenaTournamentEngineService");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

let replSet = null;
const savedEnv = {};

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE"]) savedEnv[k] = process.env[k];
  delete process.env.MONGO_STANDALONE;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "arena_schedule_test" });
});

test.after(async () => {
  engine.stopEngine();
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
  catalog.applyOverrides({});
  await ArenaTournament.deleteMany({});
});

// ── the ladder ────────────────────────────────────────────────────────────

test("one tier starts every half hour, with no gap anywhere in the cycle", () => {
  const base = catalog.cycleStart(Date.UTC(2026, 0, 1, 0, 0, 0));
  const offsets = catalog.LADDER.map((r) => r.offsetMs).sort((a, b) => a - b);

  for (let i = 1; i < offsets.length; i += 1) {
    assert.equal(
      offsets[i] - offsets[i - 1],
      30 * MIN,
      `rung ${i} is ${(offsets[i] - offsets[i - 1]) / MIN} minutes after the one before it`
    );
  }
  // And the wrap back to the next cycle is the same half hour, so the gap the
  // five tiers would otherwise leave is closed.
  const wrap = base + catalog.CYCLE_MS - (base + offsets[offsets.length - 1]);
  assert.equal(wrap, 30 * MIN, "the cycle boundary leaves dead air");
});

test("the cycle divides the day, so every cup keeps the same clock times", () => {
  assert.equal(24 * HOUR % catalog.CYCLE_MS, 0, "the cycle does not divide the day");

  // A tier's start times must land on the same wall-clock minutes on any day.
  const timesOn = (dayIndex) => {
    const dayStart = Date.UTC(2026, 0, 1 + dayIndex);
    return catalog
      .upcomingStarts(dayStart - 1, 24 * HOUR / catalog.CYCLE_MS)
      .filter((s) => s.tierId === "pro" && s.startMs < dayStart + 24 * HOUR)
      .map((s) => new Date(s.startMs).getUTCHours() * 60 + new Date(s.startMs).getUTCMinutes());
  };

  const day0 = timesOn(0);
  assert.ok(day0.length > 0, "the top tier never runs");
  for (const day of [1, 2, 3, 4, 5, 6]) {
    assert.deepEqual(
      timesOn(day),
      day0,
      `day ${day} does not repeat day 0 — players could never learn the schedule`
    );
  }
});

test("the entry tier runs twice a cycle and the two are separate events", () => {
  const rungs = catalog.LADDER.filter((r) => r.tierId === "mini");
  assert.equal(rungs.length, 2, "the spare rung did not go to the entry tier");

  const top = catalog.cycleStart(Date.UTC(2026, 0, 1, 0, 0, 0));
  const keys = rungs.map((r) => catalog.slotKey("poker", "mini", top + r.offsetMs));
  assert.notEqual(keys[0], keys[1], "both rungs share a slot key and would collide on upsert");
});

test("every tier in the catalog has a rung, and every rung a tier", () => {
  const tierIds = new Set(catalog.resolvedTiers().map((t) => t.id));
  const rungIds = new Set(catalog.LADDER.map((r) => r.tierId));
  for (const id of tierIds) {
    assert.ok(rungIds.has(id), `tier "${id}" is in the catalog but never scheduled`);
  }
  for (const id of rungIds) {
    assert.ok(tierIds.has(id), `rung "${id}" is scheduled but is not a tier`);
  }
});

test("the next start is always less than half an hour away", () => {
  // Whenever a player opens the lobby, something has to be about to begin.
  for (let m = 0; m < 180; m += 7) {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0) + m * MIN;
    const next = catalog.upcomingStarts(now, 1)[0];
    assert.ok(next, `nothing scheduled at +${m}m`);
    assert.ok(
      next.startMs - now <= 30 * MIN,
      `at +${m}m the next start is ${(next.startMs - now) / MIN} minutes away`
    );
  }
});

// ── seeding ───────────────────────────────────────────────────────────────

test("the three games share each rung, at the same instant", async () => {
  const now = Date.UTC(2026, 5, 1, 9, 0, 0);
  await engine.ensureSchedule(now);

  const first = catalog.upcomingStarts(now, 1)[0];
  const rows = await ArenaTournament.find({
    origin: "house",
    startAt: new Date(first.startMs),
  }).lean();

  assert.deepEqual(
    rows.map((r) => r.game).sort(),
    ["poker", "tarneeb41", "trix"],
    "the rung does not carry all three games"
  );
  for (const r of rows) assert.equal(r.tierId, first.tierId);
});

test("running the schedule again changes nothing", async () => {
  const now = Date.UTC(2026, 5, 1, 9, 0, 0);
  await engine.ensureSchedule(now);
  const first = await ArenaTournament.countDocuments({ origin: "house" });
  await engine.ensureSchedule(now);
  await engine.ensureSchedule(now);
  const after = await ArenaTournament.countDocuments({ origin: "house" });
  assert.equal(after, first, "the schedule duplicated itself");
});

// ── retiring the old grid ─────────────────────────────────────────────────

test("an empty slot the ladder no longer schedules is cleaned up", async () => {
  const now = Date.UTC(2026, 5, 1, 9, 0, 0);
  // A leftover from the old 2-hour grid: a real slot key, not on the ladder.
  const orphanStart = now + 5 * HOUR + 17 * MIN;
  await ArenaTournament.create({
    origin: "house",
    game: "poker",
    tierId: "medium",
    name: "بوكر · أكبر · 8 جولات",
    visibility: "public",
    type: "paid",
    entryFee: 4000,
    startingChips: 6000,
    prizePool: 0,
    maxPlayers: 16,
    minPlayers: 8,
    startAt: new Date(orphanStart),
    durationMinutes: 8,
    lifecycle: "registering",
    slotKey: `house:poker:medium:${orphanStart}`,
    participants: [],
  });

  await engine.ensureSchedule(now);

  const still = await ArenaTournament.findOne({ slotKey: `house:poker:medium:${orphanStart}` }).lean();
  assert.equal(still, null, "the old grid is still in the lobby beside the new one");
});

test("a tournament somebody has entered is never moved or removed", async () => {
  // The whole point of the cleanup rule. This is money already taken and a
  // start time a player is waiting on.
  const now = Date.UTC(2026, 5, 1, 9, 0, 0);
  const orphanStart = now + 5 * HOUR + 17 * MIN;
  const player = new mongoose.Types.ObjectId();

  const doc = await ArenaTournament.create({
    origin: "house",
    game: "poker",
    tierId: "medium",
    name: "بوكر · أكبر · 8 جولات",
    visibility: "public",
    type: "paid",
    entryFee: 4000,
    startingChips: 6000,
    prizePool: 4000,
    maxPlayers: 16,
    minPlayers: 8,
    startAt: new Date(orphanStart),
    durationMinutes: 8,
    lifecycle: "registering",
    slotKey: `house:poker:medium:${orphanStart}`,
    participants: [{ user: player }],
  });

  await engine.ensureSchedule(now);

  const after = await ArenaTournament.findById(doc._id).lean();
  assert.ok(after, "a paid tournament was deleted by the schedule cleanup");
  assert.equal(
    after.startAt.getTime(),
    orphanStart,
    "a paid tournament's start time was moved out from under its players"
  );
  assert.equal(after.prizePool, 4000, "the escrow was disturbed");
});

test("a slot whose start has already arrived is left to the starter", async () => {
  // It is not on the upcoming list either, but deleting it here would race the
  // next step of the same tick — the one that moves it to "running".
  const now = Date.UTC(2026, 5, 1, 9, 0, 0);
  const dueStart = now - 30 * 1000;
  await ArenaTournament.create({
    origin: "house",
    game: "trix",
    tierId: "mini",
    name: "كأس المبتدئين · تركس",
    visibility: "public",
    type: "paid",
    entryFee: 250,
    startingChips: 2000,
    prizePool: 0,
    maxPlayers: 8,
    minPlayers: 4,
    startAt: new Date(dueStart),
    durationMinutes: 4,
    lifecycle: "registering",
    slotKey: `house:trix:mini:${dueStart}`,
    participants: [],
  });

  await engine.ensureSchedule(now);

  const still = await ArenaTournament.findOne({ slotKey: `house:trix:mini:${dueStart}` }).lean();
  assert.ok(still, "the schedule deleted a tournament at the moment it was due to start");
});

test("a player-made tournament is untouched by the house cleanup", async () => {
  const now = Date.UTC(2026, 5, 1, 9, 0, 0);
  const startMs = now + 4 * HOUR;
  const doc = await ArenaTournament.create({
    origin: "player",
    game: "poker",
    tierId: "medium",
    name: "بطولة الرفاق",
    visibility: "private",
    type: "paid",
    entryFee: 4000,
    startingChips: 6000,
    prizePool: 0,
    maxPlayers: 16,
    minPlayers: 8,
    startAt: new Date(startMs),
    durationMinutes: 8,
    lifecycle: "registering",
    participants: [],
  });

  await engine.ensureSchedule(now);

  assert.ok(
    await ArenaTournament.findById(doc._id).lean(),
    "the house schedule deleted a tournament a player created and paid for"
  );
});

console.log("arenaSchedule.test.js: all tests registered");
