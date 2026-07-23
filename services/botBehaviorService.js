/**
 * Bot behavior math — personality/skill tuning, human-like reaction delays and
 * small decision perturbations. Pure helpers, injected into the EXISTING decision
 * functions (poker playBotTurn, TrixBot, TarneebBot) as tuned constants / optional
 * args. Never rewrites the game logic; with no tuning supplied, callers get the
 * original behavior.
 */
const crypto = require("crypto");
const { PERSONALITY_TUNING, SKILL_TUNING, BOT_DEFAULTS } = require("../config/botConfig");

// Cached global knobs (refreshed from BotSettings; env/BOT_DEFAULTS fallback).
let _settings = {
  thinkMinMs: BOT_DEFAULTS.thinkMinMs,
  thinkMaxMs: BOT_DEFAULTS.thinkMaxMs,
  chatFrequency: BOT_DEFAULTS.chatFrequency,
  emojiFrequency: BOT_DEFAULTS.emojiFrequency,
};
function applySettings(s) {
  if (!s) return;
  _settings = {
    thinkMinMs: s.thinkMinMs ?? _settings.thinkMinMs,
    thinkMaxMs: s.thinkMaxMs ?? _settings.thinkMaxMs,
    chatFrequency: s.chatFrequency ?? _settings.chatFrequency,
    emojiFrequency: s.emojiFrequency ?? _settings.emojiFrequency,
  };
}
function getSettings() {
  return _settings;
}

function rand01() {
  return crypto.randomInt(0, 1_000_000) / 1_000_000;
}
function randBetween(min, max) {
  if (max <= min) return min;
  return min + crypto.randomInt(0, Math.floor(max - min));
}

/** Effective tuning for personality+skill, with optional per-bot overrides on top. */
function tuningFor(personality, skill, overrides = null) {
  const p = PERSONALITY_TUNING[personality] || PERSONALITY_TUNING.professional;
  const s = SKILL_TUNING[skill] || SKILL_TUNING.normal;
  return { ...p, ...s, ...(overrides || {}) };
}

/**
 * Human-like think delay (ms). Scaled by personality timingScale and the action
 * kind (folds are quick, raises/bids deliberate), bounded by BotSettings. Always
 * randomized — never a constant.
 */
function thinkDelay({ personality, skill, actionType = "act", tuning = null } = {}) {
  const t = tuning || tuningFor(personality, skill);
  const { thinkMinMs, thinkMaxMs } = _settings;
  let base = randBetween(thinkMinMs, thinkMaxMs);
  base *= t.timingScale || 1;
  if (actionType === "fold") base *= 0.6;
  else if (actionType === "raise" || actionType === "bid") base *= 1.25;
  // Small extra human jitter (±15%).
  base *= 0.85 + rand01() * 0.3;
  return Math.max(250, Math.round(base));
}

/**
 * Scale a poker action probability threshold by personality. `kind` selects which
 * multiplier applies. Returns a clamped [0,1] threshold. Passing no tuning yields
 * the original threshold unchanged.
 */
function pokerThreshold(base, tuning, kind) {
  if (!tuning) return base;
  let mul = 1;
  if (kind === "raise") mul = tuning.raiseMul ?? 1;
  else if (kind === "bluff") mul = tuning.bluffMul ?? 1;
  else if (kind === "call") mul = tuning.callBias ?? 1;
  const v = base * mul;
  return Math.max(0, Math.min(1, v));
}

/**
 * True when a lower-skill bot should make a deliberate sub-optimal choice this
 * turn (card games). Expert → always false (mistakeRate 0).
 */
function shouldMisplay(skill, tuning = null) {
  const rate = (tuning && tuning.mistakeRate != null ? tuning.mistakeRate : (SKILL_TUNING[skill]?.mistakeRate ?? 0));
  if (rate <= 0) return false;
  return rand01() < rate;
}

/** Social event probability (chat/emoji), personality-scaled and clamped. */
function socialChance(kind, tuning) {
  const base = kind === "emoji" ? _settings.emojiFrequency : _settings.chatFrequency;
  const mul = kind === "emoji" ? (tuning?.emojiMul ?? 1) : (tuning?.chatMul ?? 1);
  return Math.max(0, Math.min(1, base * mul));
}

function roll(p) {
  return rand01() < p;
}

module.exports = {
  applySettings,
  getSettings,
  tuningFor,
  thinkDelay,
  pokerThreshold,
  shouldMisplay,
  socialChance,
  roll,
  rand01,
};
