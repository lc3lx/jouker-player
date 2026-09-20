"use strict";

/**
 * Named atomic sequences.
 *
 * A counter is the only allocator that survives deletion. The pattern used
 * elsewhere in this repo for table numbers (`tableFactory.js`) reads
 * `max(field) + 1` and retries on E11000 — which is correct only while nothing
 * ever vacates a number. Player numbers vacate two ways: `DELETE
 * /api/v1/users/:id` really removes the document (`handlersFactory.deleteOne`),
 * and buying a vanity id retires the old one. Under max+1 either one lowers the
 * maximum and the next signup is handed a number that used to belong to
 * somebody.
 *
 * `$inc` on a single document never rewinds, so "a number is never reissued"
 * becomes a property of the mechanism instead of a check somebody has to
 * remember to write.
 */

const mongoose = require("mongoose");

const counterSchema = new mongoose.Schema(
  {
    /** Sequence name, e.g. "playerId". */
    _id: { type: String, required: true },
    /** Highest value handed out so far. Monotonic; never decremented. */
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false, timestamps: true }
);

const Counter = mongoose.model("Counter", counterSchema);

module.exports = Counter;
