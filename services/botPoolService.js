/**
 * Bot identity pool — the single provider of persistent bot identities for all
 * three games. The hot paths that spawn bot seats (poker createBotSeat, card
 * fillWithBots) are synchronous, so the pool is kept warm IN MEMORY and claimed
 * synchronously; DB persistence of the in-use flag happens in the background.
 *
 * IMPORTANT: this only supplies IDENTITY (userId/name/avatar/personality). The
 * seat's `isBot:true` flag is untouched, so settlement still nulls the wallet —
 * bots never move real coins (see gameSettlementService.participantsFromTableAndGame).
 */
const User = require("../models/userModel");
const botBehaviorService = require("./botBehaviorService");
const logger = require("../utils/logger");

let _identities = []; // [{ userId, name, avatar, personality, skill, language }]
const _inUse = new Set(); // userId strings currently seated (in this process)
const _registry = new Set(); // all bot userId strings (for isBotUser)
let _loaded = false;
let _loadingPromise = null;

function toIdentity(u) {
  return {
    userId: String(u._id),
    name: u.name || "Player",
    avatar: u.profileImg || u.bot?.avatarKey || null,
    personality: u.bot?.personality || "professional",
    skill: u.bot?.skill || "normal",
    language: u.preferences?.language || "ar",
    tuning: u.bot?.tuning || null,
  };
}

async function refresh() {
  try {
    const rows = await User.find({ isBot: true, "bot.enabled": { $ne: false } })
      .select("name profileImg preferences.language bot")
      .lean();
    _identities = rows.map(toIdentity);
    _registry.clear();
    for (const r of rows) _registry.add(String(r._id));
    _loaded = true;
    logger.info?.("bot_pool_loaded", { count: _identities.length });
    return _identities.length;
  } catch (e) {
    logger.warn?.("bot_pool_refresh_failed", { reason: e?.message });
    return 0;
  }
}

/** Idempotent warm-up. Safe to call at boot and lazily. */
function init() {
  if (_loaded) return Promise.resolve(_identities.length);
  if (!_loadingPromise) _loadingPromise = refresh();
  return _loadingPromise;
}

// Kick off a background load as soon as the module is required.
init().catch(() => {});

/** Effective tuning for a personality+skill (per-bot overrides merged on top). */
function tuningFor(personality, skill, overrides = null) {
  return botBehaviorService.tuningFor(personality, skill, overrides);
}

/**
 * Claim a persistent bot identity for a new seat (synchronous). Prefers a bot not
 * already seated (in this process); when the warm pool is exhausted it reuses one
 * (excluding those already at this table) so hundreds of tables still fill. Returns
 * null when no identity is available — callers fall back to their synthetic bot.
 */
function acquire(excludeUserIds = []) {
  if (!_identities.length) return null;
  const exclude = new Set((excludeUserIds || []).map(String));

  // 1) A free bot not in use anywhere in this process.
  const free = _identities.filter((b) => !_inUse.has(b.userId) && !exclude.has(b.userId));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  let chosen = free.length ? pick(free) : null;

  // 2) Pool exhausted → reuse any bot not already at THIS table.
  if (!chosen) {
    const reusable = _identities.filter((b) => !exclude.has(b.userId));
    if (!reusable.length) return null;
    chosen = pick(reusable);
  }

  _inUse.add(chosen.userId);
  // Persist in-use / activity in the background (best-effort, cross-process hint).
  User.updateOne(
    { _id: chosen.userId },
    { $set: { "bot.inUse": true, "bot.lastSeatedAt": new Date(), "bot.activity": "playing" } }
  ).catch(() => {});

  return { ...chosen, tuning: tuningFor(chosen.personality, chosen.skill, chosen.tuning) };
}

/** Release a bot when its seat is vacated / it "leaves" the table. */
function release(userId) {
  const id = String(userId);
  _inUse.delete(id);
  if (_registry.has(id)) {
    User.updateOne(
      { _id: id },
      { $set: { "bot.inUse": false, "bot.activity": "recently_online", lastOnline: new Date() } }
    ).catch(() => {});
  }
}

/**
 * Recognise a bot user id. Covers persistent bots (registry) AND the legacy
 * synthetic prefixes still used as a fallback and by the vacate path.
 */
function isBotUser(userId) {
  if (userId == null) return false;
  const s = String(userId);
  if (_registry.has(s)) return true;
  return s.startsWith("bot:") || s.startsWith("bot_fill_") || s.startsWith("bot_vacate_");
}

function isLoaded() {
  return _loaded;
}
function count() {
  return _identities.length;
}
/** Test/maintenance hook. */
function _reset() {
  _identities = [];
  _inUse.clear();
  _registry.clear();
  _loaded = false;
  _loadingPromise = null;
}

module.exports = {
  init,
  refresh,
  acquire,
  release,
  isBotUser,
  tuningFor,
  isLoaded,
  count,
  _reset,
};
