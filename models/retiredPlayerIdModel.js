"use strict";

/**
 * Player numbers that may never be handed out again.
 *
 * For the ordinary range (1001+) the counter already guarantees this — it never
 * rewinds. This collection exists for the ranges the counter does not govern:
 * a vanity number (101-1000) vacated when its owner upgraded, and any number an
 * admin moved a player off. Those are the paths where a human could otherwise
 * resurrect somebody's old identity, so "retired" here is a hard reject with no
 * force override.
 */

const mongoose = require("mongoose");

const retiredPlayerIdSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, unique: true, min: 1 },
    previousOwner: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    reason: {
      type: String,
      enum: ["special_purchase", "admin_change", "account_deleted"],
      required: true,
    },
    retiredAt: { type: Date, default: Date.now },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { versionKey: false }
);

const RetiredPlayerId = mongoose.model("RetiredPlayerId", retiredPlayerIdSchema);

module.exports = RetiredPlayerId;
