"use strict";

/**
 * Give every existing user a player number, in join order, starting at 1001.
 *
 * Safe to run against a live server. The trick is the block reservation: the
 * counter is advanced past the entire range in one `$inc` before a single user
 * is written, so a signup happening at the same moment is handed a number above
 * the block and can never collide with one we are about to assign.
 *
 * Idempotent and resumable — only users still missing a number are touched.
 *
 *   node scripts/backfillPlayerIds.js            # run it
 *   node scripts/backfillPlayerIds.js --dry      # show what it would do
 *   node scripts/backfillPlayerIds.js --limit 50
 */

require("dotenv").config({ path: "config.env" });

const mongoose = require("mongoose");
const User = require("../models/userModel");
const playerIdService = require("../services/playerIdService");
const { ensurePlayerIdIndexes } = require("../services/playerIdSchemaService");

const BATCH_SIZE = 1000;

async function backfillPlayerIds({ dry = false, limit = 0, log = console.log } = {}) {
  // The unique index has to exist before we start writing, or a concurrent
  // signup could duplicate a number we assign and nothing would notice.
  await ensurePlayerIdIndexes();

  const missingFilter = { playerId: { $exists: false } };
  const total = await User.countDocuments(missingFilter);
  const target = limit > 0 ? Math.min(limit, total) : total;

  if (target === 0) {
    log("nothing to do — every user already has a player number");
    return { assigned: 0, skipped: 0, total: 0 };
  }

  log(`${total} user(s) without a player number; assigning ${target}`);

  if (dry) {
    const preview = await User.find(missingFilter)
      .sort({ createdAt: 1, _id: 1 })
      .limit(10)
      .select("name createdAt")
      .lean();
    for (const u of preview) {
      log(`  would number: ${u.name} (${new Date(u.createdAt).toISOString()})`);
    }
    if (total > 10) log(`  ... and ${total - 10} more`);
    return { assigned: 0, skipped: 0, total, dry: true };
  }

  const { start } = await playerIdService.allocateOrdinaryIdBlock(target);
  log(`reserved ${start}..${start + target - 1}`);

  // `_id` as a tiebreak because bulk-seeded bots share createdAt to the
  // millisecond, and without it the order would differ between runs.
  const cursor = User.find(missingFilter)
    .sort({ createdAt: 1, _id: 1 })
    .select("_id")
    .limit(target > 0 ? target : 0)
    .cursor();

  let next = start;
  let assigned = 0;
  let skipped = 0;
  let ops = [];

  async function flush() {
    if (ops.length === 0) return;
    const res = await User.bulkWrite(ops, { ordered: false }).catch((err) => {
      // ordered:false reports per-op failures without aborting the batch.
      if (err?.result) return err.result;
      throw err;
    });
    const modified = res.modifiedCount ?? res.nModified ?? 0;
    assigned += modified;
    skipped += ops.length - modified;
    ops = [];
    log(`  ${assigned} assigned, ${skipped} skipped`);
  }

  for await (const doc of cursor) {
    ops.push({
      updateOne: {
        // CAS: a user numbered by a concurrent read while we streamed is left
        // exactly as they are.
        filter: { _id: doc._id, playerId: { $exists: false } },
        update: { $set: { playerId: next } },
      },
    });
    next += 1;
    if (ops.length >= BATCH_SIZE) await flush();
  }
  await flush();

  log(`done — ${assigned} assigned, ${skipped} skipped`);
  return { assigned, skipped, total };
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) || 0 : 0;

  const uri =
    process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DB_URI;
  if (!uri) {
    console.error("no MONGODB_URI / MONGO_URI / DB_URI in the environment");
    process.exit(1);
  }
  await mongoose.connect(uri);
  try {
    await backfillPlayerIds({ dry, limit });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { backfillPlayerIds };
