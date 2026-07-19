const mongoose = require("mongoose");

/**
 * Economy seasons — items can belong to a season (via item.requiredSeason /
 * item.season). Admin controls activation; a season being "active" is derived
 * from `active` AND the current time being inside [startDate, endDate] when
 * dates are set.
 */
const economySeasonSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true },
    nameAr: { type: String, default: null },
    description: { type: String, default: null },
    icon: { type: String, default: null },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    /** Admin master switch — independent of the date window. */
    active: { type: Boolean, default: false, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** A season is live when the admin switch is on and (if set) the date window contains now. */
economySeasonSchema.methods.isLive = function isLive(at = Date.now()) {
  if (!this.active) return false;
  const t = at instanceof Date ? at.getTime() : at;
  if (this.startDate && t < this.startDate.getTime()) return false;
  if (this.endDate && t > this.endDate.getTime()) return false;
  return true;
};

module.exports = mongoose.model("EconomySeason", economySeasonSchema);
