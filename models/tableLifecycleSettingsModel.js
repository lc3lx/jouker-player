const mongoose = require("mongoose");
const { POKER_TIMINGS } = require("../utils/poker/timings");

/**
 * Singleton admin config for table-lifecycle timing (mirrors the BotSettings
 * pattern). Every reconnect/vacate/GC timeout the table system uses is
 * readable here so admins can tune it live without a deploy. Code defaults
 * mirror the existing env-driven constants (utils/poker/timings,
 * cardTableVacateService, tableGcService, pokerTableGcService) — this model
 * only adds a live-tunable override layer on top of them. Defaults are
 * inlined (not imported from those service files) to keep this model's
 * dependency graph limited to config/util, matching botSettingsModel.
 */
const tableLifecycleSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true, default: "default", index: true },

    pokerReconnectWindowMs: { type: Number, default: POKER_TIMINGS.RECONNECT_WINDOW_MS, min: 0 },
    pokerVacateWindowMs: { type: Number, default: POKER_TIMINGS.VACATE_WINDOW_MS, min: 0 },
    pokerWaitForPlayersMs: { type: Number, default: POKER_TIMINGS.WAIT_FOR_PLAYERS_MS, min: 0 },
    tarneeb41VacateMs: {
      type: Number,
      default: Math.max(5000, parseInt(process.env.CARD_TABLE_VACATE_MS || "60000", 10)),
      min: 0,
    },
    trixVacateMs: {
      type: Number,
      default: Math.max(
        5000,
        parseInt(process.env.TRIX_VACATE_MS || process.env.CARD_TABLE_VACATE_MS || "30000", 10)
      ),
      min: 0,
    },

    cardIdleTimeoutMs: {
      type: Number,
      default: Math.max(60000, parseInt(process.env.TABLE_IDLE_TIMEOUT_MS || "900000", 10)),
      min: 0,
    },
    cardGcIntervalMs: {
      type: Number,
      default: Math.max(30000, parseInt(process.env.TABLE_GC_INTERVAL_MS || "60000", 10)),
      min: 0,
    },
    pokerEmptyGcMs: {
      type: Number,
      default: Math.max(60000, parseInt(process.env.POKER_EMPTY_TABLE_GC_MS || "300000", 10)),
      min: 0,
    },
    pokerGcIntervalMs: {
      type: Number,
      default: Math.max(30000, parseInt(process.env.POKER_GC_INTERVAL_MS || "60000", 10)),
      min: 0,
    },
  },
  { timestamps: true }
);

tableLifecycleSettingsSchema.statics.getDefaults = async function getDefaults() {
  let s = await this.findOne({ key: "default" });
  if (!s) s = await this.create({ key: "default" });
  return s;
};

module.exports = mongoose.model("TableLifecycleSettings", tableLifecycleSettingsSchema);
