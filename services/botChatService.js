/**
 * Bot social chat/emoji — decides WHEN a bot should say something and builds a
 * localized, rate-limited message. Transport-agnostic: it returns
 * `{ message, delayMs }` (or null) and the caller emits it through the game's
 * existing channel (poker `this.nsp.to(room)`, card games via `this._emit`).
 * This reuses the human table-chat payload shape (tableChat.buildChatMessage), so
 * there is NO new client logic — bots look exactly like chatting players.
 *
 * Guarantees: never spam. Enforces a per-bot cooldown AND a per-table cooldown so
 * two bots never talk over each other, on top of a personality-scaled probability.
 */
const tableChat = require("../sockets/tableChat");
const botBehaviorService = require("./botBehaviorService");
const { CHAT_LINES, EMOJIS, BOT_DEFAULTS } = require("../config/botConfig");

// Rate-limit memory (per process). Cleared entries are harmless.
const _botLast = new Map(); // botUserId -> ts of last social message
const _tableLast = new Map(); // tableId -> ts of last bot message at that table

let _cooldowns = {
  chatCooldownMs: BOT_DEFAULTS.chatCooldownMs,
  tableChatCooldownMs: BOT_DEFAULTS.tableChatCooldownMs,
};
function applySettings(s) {
  if (!s) return;
  _cooldowns = {
    chatCooldownMs: s.chatCooldownMs ?? _cooldowns.chatCooldownMs,
    tableChatCooldownMs: s.tableChatCooldownMs ?? _cooldowns.tableChatCooldownMs,
  };
}

function pickLine(personality, lang) {
  const langLines = CHAT_LINES[lang] || CHAT_LINES.ar;
  // Blend generic lines with any personality-specific flavor.
  const pool = [...(langLines.generic || []), ...(langLines[personality] || [])];
  if (!pool.length) return null;
  return pool[Math.floor(botBehaviorService.rand01() * pool.length)];
}
function pickEmoji() {
  return EMOJIS[Math.floor(botBehaviorService.rand01() * EMOJIS.length)];
}

/**
 * Decide whether one of `bots` should speak in reaction to `event`, and build the
 * message. Returns { message, delayMs } or null. `bots` = array of
 * { userId, name, avatar, lang, personality, tuning }.
 */
function maybeChat({ bots = [], tableId, event = "generic" } = {}) {
  if (!Array.isArray(bots) || bots.length === 0 || !tableId) return null;

  // Per-table cooldown — at most one bot line per table per window.
  const now = Date.now();
  const tLast = _tableLast.get(String(tableId)) || 0;
  if (now - tLast < _cooldowns.tableChatCooldownMs) return null;

  // Eligible bots: past their personal cooldown.
  const eligible = bots.filter((b) => {
    if (!b || !b.userId) return false;
    return now - (_botLast.get(String(b.userId)) || 0) >= _cooldowns.chatCooldownMs;
  });
  if (!eligible.length) return null;

  const bot = eligible[Math.floor(botBehaviorService.rand01() * eligible.length)];
  const tuning = bot.tuning || botBehaviorService.tuningFor(bot.personality, bot.skill);

  // Roll independent chances for emoji vs text (emoji is a bit more frequent).
  const wantEmoji = botBehaviorService.roll(botBehaviorService.socialChance("emoji", tuning));
  const wantChat = botBehaviorService.roll(botBehaviorService.socialChance("chat", tuning));
  if (!wantEmoji && !wantChat) return null;

  const lang = bot.lang || "ar";
  let body = null;
  let emoji = null;
  if (wantEmoji && (!wantChat || botBehaviorService.rand01() < 0.5)) {
    emoji = pickEmoji();
  } else {
    body = pickLine(bot.personality, lang);
  }
  if (!body && !emoji) return null;

  const built = tableChat.buildChatMessage({
    userId: bot.userId,
    name: bot.name,
    avatar: bot.avatar,
    body,
    emoji,
  });
  if (!built.ok) return null;

  // Reserve the cooldowns now (the emit is delayed but the slot is taken).
  _botLast.set(String(bot.userId), now);
  _tableLast.set(String(tableId), now);

  const delayMs = botBehaviorService.thinkDelay({
    personality: bot.personality,
    skill: bot.skill,
    tuning,
    actionType: event === "hand_end" ? "raise" : "act",
  });
  return { message: built.message, delayMs };
}

/** Normalize a game seat/player into the bot shape maybeChat expects. */
function botFromSeat(s) {
  if (!s || !s.isBot) return null;
  return {
    userId: s.botUserId || s.userId,
    name: s.name || s.displayName,
    avatar: s.avatar || null,
    lang: s.botLang || "ar",
    personality: s.botPersonality || null,
    skill: s.botSkill || null,
    tuning: s.botTuning || null,
  };
}

function _reset() {
  _botLast.clear();
  _tableLast.clear();
}

module.exports = { applySettings, maybeChat, botFromSeat, pickLine, _reset };
