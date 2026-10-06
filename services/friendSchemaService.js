const Friendship = require("../models/friendshipModel");
const FriendRequest = require("../models/friendRequestModel");
const logger = require("../utils/logger");

let ensured = false;

/**
 * Fold duplicate open requests so the one-pending-per-direction index can build.
 *
 * Before that index existed, two sends landing together could both insert, so
 * older data may hold several pending rows for one from→to pair. Keep the oldest
 * (it is the one the recipient was notified about) and cancel the rest.
 */
async function cancelDuplicatePendingRequests() {
  const dupes = await FriendRequest.aggregate([
    { $match: { status: "pending" } },
    { $sort: { createdAt: 1, _id: 1 } },
    { $group: { _id: { from: "$from", to: "$to" }, ids: { $push: "$_id" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  const extra = dupes.flatMap((d) => d.ids.slice(1));
  if (!extra.length) return;
  await FriendRequest.updateMany(
    { _id: { $in: extra }, status: "pending" },
    { $set: { status: "cancelled", respondedAt: new Date() } }
  );
  logger.info("friend_request_duplicates_cancelled", { count: extra.length });
}

/**
 * Repair the friendship pair index, and install the friend-request one.
 *
 * Friendship used to declare `index({ users: 1 }, { unique: true })`. `users` is
 * an array, so Mongo built a MULTIKEY unique index and enforced uniqueness on
 * each element rather than on the pair: once a user was in one friendship, every
 * later friendship containing them failed with E11000. Every account was capped
 * at exactly one friend and the second "accept" returned a 500.
 *
 * Deployments that already booted have `users_1` installed, and Mongoose never
 * drops an index it no longer declares — so drop it explicitly, then let
 * syncIndexes install the correct positional pair index.
 *
 * Idempotent, and safe to call on a fresh database that never had the old index.
 */
async function ensureFriendshipIndexes() {
  if (ensured) return;
  ensured = true;
  try {
    const coll = Friendship.collection;
    const indexes = await coll.indexes().catch(() => []);
    for (const ix of indexes) {
      const key = ix.key || {};
      const isLegacyUsersUnique =
        ix.unique === true &&
        Object.keys(key).length === 1 &&
        key.users === 1;
      if (!isLegacyUsersUnique) continue;
      try {
        await coll.dropIndex(ix.name);
        logger.info("friendship_legacy_unique_index_dropped", { index: ix.name });
      } catch (dropErr) {
        logger.warn("friendship_legacy_index_drop_failed", {
          index: ix.name,
          reason: dropErr?.message || "unknown",
        });
      }
    }
    await Friendship.syncIndexes();
  } catch (e) {
    // A friendship index problem must never stop the server from booting; the
    // log plus the dropped index on the next boot is enough.
    logger.warn("friendship_index_ensure_failed", { reason: e?.message || "unknown" });
  }
  try {
    await cancelDuplicatePendingRequests();
    // createIndexes, not syncIndexes: only add what the schema declares, never
    // drop an index someone created by hand on this collection.
    await FriendRequest.createIndexes();
  } catch (e) {
    logger.warn("friend_request_index_ensure_failed", { reason: e?.message || "unknown" });
  }
}

module.exports = { ensureFriendshipIndexes };
