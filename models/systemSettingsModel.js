const mongoose = require("mongoose");

const systemSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true, index: true },
    defaultSalesCommissionPercent: { type: Number, default: 0.05, min: 0, max: 1 },
    defaultReferralCommissionPercent: { type: Number, default: 0.02, min: 0, max: 1 },
  },
  { timestamps: true }
);

systemSettingsSchema.statics.getDefaults = async function () {
  let s = await this.findOne({ key: "default" });
  if (!s) s = await this.create({ key: "default" });
  return s;
};

module.exports = mongoose.model("SystemSettings", systemSettingsSchema);
