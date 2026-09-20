"use strict";

/**
 * The vanity player-number catalog (101-1000).
 *
 * Deliberately its own collection rather than a row in the cosmetic or
 * interaction catalogs: neither of those can express a one-of-a-kind item.
 * Both carry a `limitedEdition` flag that no business logic has ever read, and
 * the only `stock` field in the repo belongs to the dead legacy `GameItem`. A
 * number has exactly one owner forever, and the unique index on `number` is
 * what actually enforces that — every check in the service above it is a cheap
 * reject, not a guarantee.
 */

const mongoose = require("mongoose");

const SPECIAL_ID_MIN = 101;
const SPECIAL_ID_MAX = 1000;

const specialPlayerIdSchema = new mongoose.Schema(
  {
    number: {
      type: Number,
      required: true,
      unique: true,
      min: SPECIAL_ID_MIN,
      max: SPECIAL_ID_MAX,
    },
    price: { type: Number, required: true, min: 0 },
    /**
     * listed    — on sale
     * sold      — owned by `owner`
     * withdrawn — pulled from the store by an admin, may be relisted
     * retired   — its owner moved off it; gone for good, never relistable
     */
    status: {
      type: String,
      enum: ["listed", "sold", "withdrawn", "retired"],
      default: "listed",
      index: true,
    },
    owner: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    acquiredVia: {
      type: String,
      enum: ["purchase", "admin", null],
      default: null,
    },
    /** Marketing label, e.g. "ثلاثي متكرر". */
    label: { type: String, default: null, trim: true },
    /** Store grouping, e.g. "golden" / "triple" / "short". */
    tier: { type: String, default: null, trim: true },
    soldAt: { type: Date, default: null },
    soldPrice: { type: Number, default: null },
    listedBy: { type: mongoose.Schema.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// The store listing query: everything on sale, cheapest first.
specialPlayerIdSchema.index({ status: 1, price: 1 });

const SpecialPlayerId = mongoose.model("SpecialPlayerId", specialPlayerIdSchema);

module.exports = SpecialPlayerId;
module.exports.SPECIAL_ID_MIN = SPECIAL_ID_MIN;
module.exports.SPECIAL_ID_MAX = SPECIAL_ID_MAX;
