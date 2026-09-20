"use strict";

/**
 * Boot-time preparation for player numbers.
 *
 * Two jobs, both idempotent:
 *
 * 1. Install the indexes. `User.collection.createIndex` rather than
 *    `User.syncIndexes()` — syncIndexes drops every index the schema does not
 *    declare, which on this collection would take out hand-built production
 *    indexes that live outside the model file.
 *
 * 2. Raise the counter to the highest number actually in use. Without this a
 *    database restored from a backup taken before the last few signups would
 *    hand those numbers out a second time.
 */

const logger = require("../utils/logger");
const User = require("../models/userModel");
const Counter = require("../models/counterModel");
const SpecialPlayerId = require("../models/specialPlayerIdModel");
const RetiredPlayerId = require("../models/retiredPlayerIdModel");
const { bumpCounterFloor, ORDINARY_ID_MIN } = require("./playerIdService");

let ensured = false;

async function ensurePlayerIdIndexes() {
  if (ensured) return;
  ensured = true;
  try {
    await User.collection.createIndex(
      { playerId: 1 },
      {
        unique: true,
        partialFilterExpression: { playerId: { $type: "number" } },
        name: "playerId_unique",
      }
    );
  } catch (e) {
    // The only realistic cause is duplicate playerId values already in the
    // collection, and then the system is running with no uniqueness guarantee
    // at all — that is worth an error-level log, not a warning.
    logger.error("player_id_unique_index_failed", {
      reason: e?.message || "unknown",
      hint: "run scripts/backfillPlayerIds.js and check for duplicates",
    });
  }

  try {
    await Promise.all([
      SpecialPlayerId.syncIndexes(),
      RetiredPlayerId.syncIndexes(),
      Counter.syncIndexes(),
    ]);

    const top = await User.findOne({ playerId: { $gte: ORDINARY_ID_MIN } })
      .sort({ playerId: -1 })
      .select("playerId")
      .lean();
    await bumpCounterFloor(Math.max(ORDINARY_ID_MIN - 1, top?.playerId || 0));
  } catch (e) {
    logger.warn("player_id_schema_ensure_failed", {
      reason: e?.message || "unknown",
    });
  }
}

module.exports = { ensurePlayerIdIndexes };
