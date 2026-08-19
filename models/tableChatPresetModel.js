"use strict";

/**
 * Admin-managed table chat presets — free quick emojis and canned phrases.
 * Separate from the paid interaction catalog so HUD reactions stay free
 * while gifts/stickers remain a coin economy.
 */
const mongoose = require("mongoose");

const KINDS = ["emoji", "phrase"];

const schema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    kind: { type: String, required: true, enum: KINDS, index: true },
    /** Unicode glyph for kind=emoji; optional accent for phrases. */
    icon: { type: String, default: null },
    textAr: { type: String, default: null },
    textEn: { type: String, default: null },
    vipOnly: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

schema.index({ kind: 1, enabled: 1, sortOrder: 1 });

const DEFAULT_EMOJIS = [
  "👍", "👎", "😂", "😍", "😎", "😢", "😡", "🔥",
  "💰", "🃏", "👏", "🎉", "🤔", "😱", "🙏", "❤️",
];

const DEFAULT_PHRASES = [
  { key: "phrase_welcome", textAr: "مرحباً بالجميع", textEn: "Welcome everyone" },
  { key: "phrase_hurry", textAr: "أسرع لو سمحت", textEn: "Hurry up please" },
  { key: "phrase_calm", textAr: "اهداً لا تتهور", textEn: "Calm down" },
  { key: "phrase_bad_luck", textAr: "حظ سيء", textEn: "Bad luck" },
  { key: "phrase_all_in", textAr: "المراهنة بالكل", textEn: "All-in" },
  { key: "phrase_good_luck", textAr: "حظ سعيد", textEn: "Good luck" },
  { key: "phrase_raise_annoy", textAr: "الزيادة على زيادة أمر مزعج", textEn: "Re-raising is annoying" },
  { key: "phrase_change_seat", textAr: "غير مكانك للحظ", textEn: "Change your seat for luck" },
  { key: "phrase_show_money", textAr: "أرني نقودك يا صديقي", textEn: "Show me your money" },
  { key: "phrase_island", textAr: "واو لقد ربحت الجزيرة", textEn: "Wow, you won the island" },
];

const DEFAULT_PRESETS = [
  ...DEFAULT_EMOJIS.map((icon, i) => ({
    key: `emoji_free_${i + 1}`,
    kind: "emoji",
    icon,
    textAr: icon,
    textEn: icon,
    sortOrder: i + 1,
    enabled: true,
  })),
  ...DEFAULT_PHRASES.map((p, i) => ({
    ...p,
    kind: "phrase",
    icon: "💬",
    sortOrder: 100 + i,
    enabled: true,
  })),
];

schema.statics.ensureDefaults = async function ensureDefaults() {
  const existing = await this.find({}).select("key").lean();
  const have = new Set(existing.map((d) => d.key));
  const missing = DEFAULT_PRESETS.filter((d) => !have.has(d.key));
  if (missing.length > 0) await this.insertMany(missing, { ordered: false });
  return missing.length;
};

schema.statics.KINDS = KINDS;
schema.statics.DEFAULT_PRESETS = DEFAULT_PRESETS;
schema.statics.DEFAULT_EMOJIS = DEFAULT_EMOJIS;

module.exports = mongoose.model("TableChatPreset", schema);
