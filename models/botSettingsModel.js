const mongoose = require("mongoose");
const { BOT_DEFAULTS } = require("../config/botConfig");

/**
 * Singleton admin config for the whole bot system (mirrors the SystemSettings /
 * ClanSettings pattern). Every runtime knob the bot services need is read from
 * here so admins can tune bots live without a deploy. Code defaults come from
 * config/botConfig BOT_DEFAULTS (which themselves fall back to the legacy env vars).
 */
const botSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true, default: "default", index: true },

    botsEnabled: { type: Boolean, default: BOT_DEFAULTS.botsEnabled },
    maxBotsPerTable: { type: Number, default: BOT_DEFAULTS.maxBotsPerTable, min: 0 },
    minHumansToKeepBots: { type: Number, default: BOT_DEFAULTS.minHumansToKeepBots, min: 0 },
    defaultSkill: { type: String, default: BOT_DEFAULTS.defaultSkill },

    chatFrequency: { type: Number, default: BOT_DEFAULTS.chatFrequency, min: 0, max: 1 },
    emojiFrequency: { type: Number, default: BOT_DEFAULTS.emojiFrequency, min: 0, max: 1 },

    joinDelayMs: { type: Number, default: BOT_DEFAULTS.joinDelayMs, min: 0 },
    leaveDelayMs: { type: Number, default: BOT_DEFAULTS.leaveDelayMs, min: 0 },
    thinkMinMs: { type: Number, default: BOT_DEFAULTS.thinkMinMs, min: 0 },
    thinkMaxMs: { type: Number, default: BOT_DEFAULTS.thinkMaxMs, min: 0 },
    chatCooldownMs: { type: Number, default: BOT_DEFAULTS.chatCooldownMs, min: 0 },
    tableChatCooldownMs: { type: Number, default: BOT_DEFAULTS.tableChatCooldownMs, min: 0 },

    /** Managed avatar catalog (LOCAL asset keys) — admin-editable. */
    avatarCatalog: { type: [String], default: undefined },
  },
  { timestamps: true }
);

botSettingsSchema.statics.getDefaults = async function getDefaults() {
  let s = await this.findOne({ key: "default" });
  if (!s) s = await this.create({ key: "default" });
  return s;
};

module.exports = mongoose.model("BotSettings", botSettingsSchema);
