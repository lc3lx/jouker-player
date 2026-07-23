/**
 * Bot profile persistence — makes bot accounts look like long-term players by
 * drifting their DISPLAYED stats/coins/activity after games. This is fully
 * decoupled from settlement: it never touches the wallet ledger (bots stay
 * house-backed). The "coins" here are a cosmetic displayed balance only.
 *
 * All methods are fire-and-forget and guard on a real bot user id (ObjectId), so
 * calling them with a legacy synthetic `bot:`/`bot_fill_` id is a safe no-op.
 */
const mongoose = require("mongoose");
const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const Player = require("../models/playerModel");
const botPoolService = require("./botPoolService");
const logger = require("../utils/logger");

function isRealBotId(id) {
  return id != null && mongoose.isValidObjectId(String(id)) && botPoolService.isBotUser(String(id));
}
function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Record one finished game for a bot seat: advance played/won/lost, bump XP/level,
 * drift the displayed coin balance, and refresh presence. `won` may be undefined
 * for a neutral session (still counts as played).
 */
async function recordGameResult({ botUserId, gameType = null, won = null } = {}) {
  if (!isRealBotId(botUserId)) return;
  const id = String(botUserId);
  try {
    // Stats (believable, bounded drift).
    const player = await Player.getOrCreateByUser(id);
    player.stats.gamesPlayed = (player.stats.gamesPlayed || 0) + 1;
    if (won === true) player.stats.wins = (player.stats.wins || 0) + 1;
    player.stats.experience = (player.stats.experience || 0) + randInt(15, 90);
    player.stats.level = Math.max(1, Math.floor(player.stats.experience / 5000) + 1);
    await player.save();

    // Displayed coin drift — NOT via the wallet ledger. Winners gain, losers dip,
    // floored so a bot never goes broke.
    const drift = won === true ? randInt(2000, 40000) : won === false ? -randInt(1000, 25000) : randInt(-3000, 3000);
    await Wallet.updateOne(
      { user: id },
      [
        {
          $set: {
            balance: { $max: [100000, { $add: [{ $ifNull: ["$balance", 0] }, drift] }] },
          },
        },
      ]
    );

    await User.updateOne(
      { _id: id },
      { $set: { lastOnline: new Date(), "bot.activity": "playing" } }
    );
  } catch (e) {
    logger.warn?.("bot_profile_record_failed", { botUserId: id, reason: e?.message });
  }
}

/** Update believable presence/activity for a bot (playing/online/idle/…). */
async function markActivity(botUserId, activity = "online") {
  if (!isRealBotId(botUserId)) return;
  try {
    await User.updateOne(
      { _id: String(botUserId) },
      { $set: { "bot.activity": activity, lastOnline: new Date() } }
    );
  } catch (_) { /* best-effort */ }
}

/**
 * Batch-record a table's bot seats at hand/game end. `seats` is any array of
 * objects exposing a real bot id via `botUserId` (or a real ObjectId `userId`)
 * and an optional `won` flag. Legacy synthetic bots are skipped automatically.
 */
function recordSeats(seats, { gameType = null } = {}) {
  if (!Array.isArray(seats)) return;
  for (const s of seats) {
    if (!s || !s.isBot) continue;
    const id = s.botUserId || s.userId;
    if (!isRealBotId(id)) continue;
    recordGameResult({ botUserId: id, gameType, won: s.won });
  }
}

/**
 * Believable "recently online" churn for bots NOT currently seated: periodically
 * rotate a few idle bots' activity/lastOnline so friends/lobby/profiles show them
 * as living players. Cheap (one bounded update per tick) and self-unref'd.
 */
let _heartbeat = null;
function startActivityHeartbeat({ intervalMs = 5 * 60 * 1000 } = {}) {
  if (_heartbeat) return _heartbeat;
  const STATES = ["online", "recently_online", "idle", "searching"];
  _heartbeat = setInterval(async () => {
    try {
      const idle = await User.find({ isBot: true, "bot.enabled": { $ne: false }, "bot.inUse": { $ne: true } })
        .select("_id")
        .limit(50)
        .lean();
      const sample = idle.sort(() => Math.random() - 0.5).slice(0, Math.min(8, idle.length));
      await Promise.all(
        sample.map((u) =>
          User.updateOne(
            { _id: u._id },
            {
              $set: {
                "bot.activity": STATES[randInt(0, STATES.length - 1)],
                lastOnline: new Date(Date.now() - randInt(0, 30) * 60 * 1000),
              },
            }
          ).catch(() => {})
        )
      );
    } catch (_) { /* best-effort */ }
  }, intervalMs);
  if (_heartbeat.unref) _heartbeat.unref();
  return _heartbeat;
}
function stopActivityHeartbeat() {
  if (_heartbeat) clearInterval(_heartbeat);
  _heartbeat = null;
}

module.exports = {
  recordGameResult,
  markActivity,
  recordSeats,
  startActivityHeartbeat,
  stopActivityHeartbeat,
};
