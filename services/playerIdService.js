"use strict";

/**
 * Allocation and reassignment of public player numbers.
 *
 * Ranges:
 *   1    - 100   staff and agents, placed by hand from the admin panel
 *   101  - 1000  vanity numbers sold in the store (see specialPlayerIdService)
 *   1001 - ...   ordinary players, in join order
 *
 * Everything here is a cheap pre-check over one real guarantee: the partial
 * unique index `playerId_unique` on the users collection. Two requests can read
 * the same "free" number at the same moment; only one write survives.
 */

const mongoose = require("mongoose");

const ApiError = require("../utils/apiError");
const logger = require("../utils/logger");
const Counter = require("../models/counterModel");
const User = require("../models/userModel");
const RetiredPlayerId = require("../models/retiredPlayerIdModel");

const ADMIN_ID_MIN = 1;
const ADMIN_ID_MAX = 100;
const SPECIAL_ID_MIN = 101;
const SPECIAL_ID_MAX = 1000;
const ORDINARY_ID_MIN = 1001;

const COUNTER_KEY = "playerId";

/** Allocation attempts before giving up. Only ever >1 after a counter restore. */
const MAX_ALLOC_ATTEMPTS = 5;

/**
 * In-flight `ensurePlayerId` calls, keyed by user.
 *
 * Without this, N concurrent reads of the same un-numbered profile each
 * allocate a number and N-1 of them are burnt for nothing. Per-process only —
 * two app instances can still race, which the unique index settles correctly at
 * the cost of one wasted number.
 */
const _inFlight = new Map();

function isDuplicateKey(err) {
  return err && err.code === 11000;
}

/** A player number as stored: a positive integer, or null. */
function normalizeNumber(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function rangeOf(number) {
  if (number >= ORDINARY_ID_MIN) return "ordinary";
  if (number >= SPECIAL_ID_MIN) return "special";
  return "admin";
}

/**
 * Raise the sequence floor so nothing at or below `n` is ever handed out.
 *
 * `$max` and `$inc` cannot touch the same path in one update — Mongo rejects it
 * as a path conflict — so this is deliberately a separate call from
 * `allocateNextOrdinaryId`, never folded into it.
 */
async function bumpCounterFloor(n) {
  const floor = normalizeNumber(n);
  if (floor === null) return;
  await Counter.updateOne(
    { _id: COUNTER_KEY },
    { $max: { seq: floor } },
    { upsert: true }
  );
}

async function _drawNext(step = 1) {
  const doc = await Counter.findOneAndUpdate(
    { _id: COUNTER_KEY },
    { $inc: { seq: step } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
}

/** True when this number is held by somebody or burnt. */
async function _isTaken(number) {
  const [held, retired] = await Promise.all([
    User.exists({ playerId: number }),
    RetiredPlayerId.exists({ number }),
  ]);
  return Boolean(held || retired);
}

/**
 * The next free ordinary number.
 *
 * The counter alone is sufficient in normal operation; the retry loop only ever
 * fires after the counter has been restored behind reality (a database restored
 * from an older backup, say), and is here so that case degrades into a few
 * extra reads instead of a duplicate-key error on somebody's signup.
 */
async function allocateNextOrdinaryId() {
  for (let attempt = 0; attempt < MAX_ALLOC_ATTEMPTS; attempt += 1) {
    let seq = await _drawNext();
    if (seq < ORDINARY_ID_MIN) {
      // Fresh counter, or one restored below the floor.
      await bumpCounterFloor(ORDINARY_ID_MIN - 1);
      seq = await _drawNext();
    }
    if (!(await _isTaken(seq))) return seq;
    logger.warn?.({
      event: "player_id_counter_behind",
      fields: { drawn: seq, attempt },
    });
  }
  throw new ApiError("PLAYER_ID_ALLOCATION_FAILED", 500);
}

/**
 * Reserve `count` consecutive ordinary numbers in one atomic step.
 *
 * This is what lets the backfill run against a live server: the counter jumps
 * past the whole block before a single user is written, so concurrent signups
 * cannot be handed anything inside the reserved range.
 */
async function allocateOrdinaryIdBlock(count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) throw new ApiError("INVALID_BLOCK_SIZE", 400);
  await bumpCounterFloor(ORDINARY_ID_MIN - 1);
  const end = await _drawNext(n);
  return { start: end - n + 1, end };
}

/**
 * Give `userId` a number if it has none.
 *
 * Self-healing for accounts created before this feature, or by a path that
 * skipped allocation. Cheap no-op for everybody else, so read paths can call it
 * freely.
 */
async function ensurePlayerId(userId) {
  const key = String(userId);
  if (_inFlight.has(key)) return _inFlight.get(key);

  const work = (async () => {
    const existing = await User.findById(userId).select("playerId").lean();
    if (!existing) return null;
    if (typeof existing.playerId === "number") return existing.playerId;

    for (let attempt = 0; attempt < MAX_ALLOC_ATTEMPTS; attempt += 1) {
      const number = await allocateNextOrdinaryId();
      try {
        const res = await User.updateOne(
          { _id: userId, playerId: { $exists: false } },
          { $set: { playerId: number } }
        );
        if (res.matchedCount === 0) {
          // Somebody else numbered this user while we were allocating.
          const now = await User.findById(userId).select("playerId").lean();
          return now?.playerId ?? null;
        }
        return number;
      } catch (err) {
        if (isDuplicateKey(err) && attempt < MAX_ALLOC_ATTEMPTS - 1) continue;
        throw err;
      }
    }
    throw new ApiError("PLAYER_ID_ALLOCATION_FAILED", 500);
  })().finally(() => _inFlight.delete(key));

  _inFlight.set(key, work);
  return work;
}

/**
 * Burn a number so it can never be handed out again.
 *
 * Idempotent: retiring an already-retired number is a no-op rather than an
 * error, because the callers that reach here are inside a transaction that may
 * be replayed.
 */
async function retirePlayerId({ session, number, previousOwner, reason, meta }) {
  const n = normalizeNumber(number);
  if (n === null) return;
  try {
    await RetiredPlayerId.create(
      [{ number: n, previousOwner: previousOwner || null, reason, meta: meta || null }],
      session ? { session } : {}
    );
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
}

async function isRetired(number) {
  const n = normalizeNumber(number);
  if (n === null) return false;
  return Boolean(await RetiredPlayerId.exists({ number: n }));
}

/**
 * Move a user onto `number`, retiring whatever they held before.
 *
 * The shared primitive behind buying a vanity number and an admin placing a
 * staff member. Must be called inside a transaction — it writes two documents
 * that have to move together.
 */
async function assignPlayerId({ session, userId, number, reason, meta }) {
  const target = normalizeNumber(number);
  if (target === null) throw new ApiError("رقم غير صالح", 400);

  // Retired means retired, and the check belongs here rather than in each
  // caller — a guarantee that depends on every route remembering to ask is not
  // a guarantee. There is deliberately no force flag.
  const burnt = await RetiredPlayerId.findOne({ number: target })
    .select("_id")
    .session(session || null);
  if (burnt) {
    throw new ApiError("هذا الرقم متقاعد ولا يمكن إعطاؤه لأحد", 409);
  }

  const user = await User.findById(userId).select("playerId").session(session || null);
  if (!user) throw new ApiError("اللاعب غير موجود", 404);

  const previous = typeof user.playerId === "number" ? user.playerId : null;
  if (previous === target) return { playerId: target, previousPlayerId: previous };

  if (previous !== null) {
    await retirePlayerId({
      session,
      number: previous,
      previousOwner: userId,
      reason,
      meta,
    });
  }

  // Compare-and-swap on the number we read, so a concurrent reassignment of the
  // same user loses instead of silently overwriting.
  const filter =
    previous === null
      ? { _id: userId, playerId: { $exists: false } }
      : { _id: userId, playerId: previous };

  let res;
  try {
    res = await User.updateOne(
      filter,
      { $set: { playerId: target } },
      session ? { session } : {}
    );
  } catch (err) {
    if (isDuplicateKey(err)) throw new ApiError("هذا الرقم مأخوذ", 409);
    throw err;
  }
  if (res.matchedCount === 0) {
    throw new ApiError("تغيّر رقم اللاعب أثناء العملية، حاول مجدداً", 409);
  }

  return { playerId: target, previousPlayerId: previous };
}

module.exports = {
  ADMIN_ID_MIN,
  ADMIN_ID_MAX,
  SPECIAL_ID_MIN,
  SPECIAL_ID_MAX,
  ORDINARY_ID_MIN,
  COUNTER_KEY,
  isDuplicateKey,
  normalizeNumber,
  rangeOf,
  bumpCounterFloor,
  allocateNextOrdinaryId,
  allocateOrdinaryIdBlock,
  ensurePlayerId,
  retirePlayerId,
  isRetired,
  assignPlayerId,
};
