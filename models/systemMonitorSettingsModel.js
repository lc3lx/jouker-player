const mongoose = require("mongoose");

/**
 * Singleton admin config for the production monitoring/self-healing sweep
 * (mirrors botSettingsModel / tableLifecycleSettingsModel). All grace periods
 * and thresholds the checker modules use are read from here so admins can
 * tune the monitor live without a deploy.
 */
const systemMonitorSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true, default: "default", index: true },

    enabled: { type: Boolean, default: true },
    sweepIntervalMs: { type: Number, default: 60000, min: 15000 },

    // Grace periods before an anomaly is treated as real (not just an
    // in-flight operation) and, where applicable, auto-repaired.
    walletLockOrphanGraceMs: { type: Number, default: 5 * 60 * 1000, min: 0 },
    stuckHandGraceMs: { type: Number, default: 2 * 60 * 1000, min: 0 },
    tournamentMatchGraceMs: { type: Number, default: 5 * 60 * 1000, min: 0 },
    repeatedAnomalyThreshold: { type: Number, default: 3, min: 1 },

    // Process-health thresholds.
    memoryWarningPct: { type: Number, default: 75, min: 1, max: 100 },
    memoryCriticalPct: { type: Number, default: 90, min: 1, max: 100 },
    eventLoopLagWarningMs: { type: Number, default: 100, min: 0 },
    eventLoopLagCriticalMs: { type: Number, default: 500, min: 0 },

    // Toggle auto-repair independent of detection (detection+alerting always runs).
    autoRepairEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

systemMonitorSettingsSchema.statics.getDefaults = async function getDefaults() {
  let s = await this.findOne({ key: "default" });
  if (!s) s = await this.create({ key: "default" });
  return s;
};

module.exports = mongoose.model("SystemMonitorSettings", systemMonitorSettingsSchema);
