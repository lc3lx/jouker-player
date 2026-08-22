"use strict";

const mongoose = require("mongoose");

const tierOverrideSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    nameAr: { type: String, trim: true, maxlength: 40 },
    entryFee: { type: Number, min: 0 },
  },
  { _id: false }
);

/**
 * Singleton admin overrides for the house card-tournament catalog
 * (name + entry fee per tier). Defaults live in arenaTournamentCatalog.js.
 */
const arenaTournamentSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true, default: "default", index: true },
    tiers: { type: [tierOverrideSchema], default: [] },
  },
  { timestamps: true }
);

arenaTournamentSettingsSchema.statics.getDefaults = async function getDefaults() {
  let s = await this.findOne({ key: "default" });
  if (!s) s = await this.create({ key: "default" });
  return s;
};

module.exports = mongoose.model("ArenaTournamentSettings", arenaTournamentSettingsSchema);
