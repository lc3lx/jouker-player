"use strict";

/**
 * The vanity player-number store (101-1000).
 *
 * A player buys a number, their old one is retired, and nobody can ever hold
 * that number again.
 *
 * What actually keeps the money safe, in order of importance:
 *
 *   1. It refuses to run without a real Mongo transaction. `withMongoTransaction`
 *      otherwise falls back to running the callback with no session on a
 *      standalone server, and then a failure halfway through would leave a
 *      player debited without their number. Everything below depends on this.
 *
 *   2. The listing is claimed before the wallet is debited. With (1) in place
 *      this is defensive rather than load-bearing — the rollback would undo a
 *      debit either way — but it keeps the losing racer from writing to its
 *      wallet at all, so the two buyers contend on one document instead of
 *      three.
 *
 *   3. Nothing with an effect outside Mongo goes inside the transaction.
 *      `session.withTransaction` replays its callback on a transient error, so
 *      a cache invalidation or an audit row in there would fire twice.
 */

const mongoose = require("mongoose");

const ApiError = require("../utils/apiError");
const logger = require("../utils/logger");
const User = require("../models/userModel");
const SpecialPlayerId = require("../models/specialPlayerIdModel");
const WalletTransaction = require("../models/walletTransactionModel");
const auditService = require("./auditService");
const playerIdService = require("./playerIdService");
const playerProfileService = require("./playerProfileService");
const ledger = require("./walletLedgerService");

const { SPECIAL_ID_MIN, SPECIAL_ID_MAX } = playerIdService;

function assertSpecialRange(number) {
  const n = playerIdService.normalizeNumber(number);
  if (n === null || n < SPECIAL_ID_MIN || n > SPECIAL_ID_MAX) {
    throw new ApiError(
      `الرقم المميز يجب أن يكون بين ${SPECIAL_ID_MIN} و ${SPECIAL_ID_MAX}`,
      400
    );
  }
  return n;
}

function publicView(doc) {
  if (!doc) return null;
  return {
    number: doc.number,
    price: doc.price,
    status: doc.status,
    label: doc.label || null,
    tier: doc.tier || null,
  };
}

function adminView(doc) {
  if (!doc) return null;
  return {
    ...publicView(doc),
    owner: doc.owner ? String(doc.owner) : null,
    acquiredVia: doc.acquiredVia || null,
    soldAt: doc.soldAt || null,
    soldPrice: doc.soldPrice ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/* ------------------------------------------------------------------ store -- */

async function listStore({ page = 1, limit = 30, minPrice, maxPrice, tier } = {}) {
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const pg = Math.max(1, parseInt(page, 10) || 1);

  const filter = { status: "listed" };
  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.price = {};
    if (minPrice !== undefined) filter.price.$gte = Number(minPrice) || 0;
    if (maxPrice !== undefined) filter.price.$lte = Number(maxPrice) || 0;
  }
  if (tier) filter.tier = String(tier);

  const [rows, total] = await Promise.all([
    SpecialPlayerId.find(filter)
      .sort({ price: 1, number: 1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean(),
    SpecialPlayerId.countDocuments(filter),
  ]);

  return { items: rows.map(publicView), total, page: pg, limit: lim };
}

async function getListed(number) {
  const n = assertSpecialRange(number);
  const doc = await SpecialPlayerId.findOne({ number: n, status: "listed" }).lean();
  if (!doc) throw new ApiError("هذا الرقم غير معروض للبيع", 404);
  return publicView(doc);
}

/* --------------------------------------------------------------- purchase -- */

/**
 * Buy a vanity number.
 *
 * `requestKey` is optional and makes a double-submit safe: the ledger already
 * holds a row for that key, so the second attempt returns the first result
 * instead of charging again.
 */
async function purchaseSpecialId({ userId, number, requestKey }) {
  const n = assertSpecialRange(number);

  // Cheap rejects, outside the transaction. None of these is a guarantee —
  // the claim below is.
  const user = await User.findById(userId).select("playerId active isBot role").lean();
  if (!user) throw new ApiError("اللاعب غير موجود", 404);
  if (user.active === false) throw new ApiError("الحساب موقوف", 403);
  if (user.isBot) throw new ApiError("غير متاح لهذا الحساب", 403);
  if (user.playerId === n) {
    return { duplicate: true, playerId: n, previousPlayerId: n, price: 0 };
  }

  const listing = await SpecialPlayerId.findOne({ number: n }).lean();
  if (!listing) throw new ApiError("هذا الرقم غير معروض للبيع", 404);
  if (listing.status !== "listed") throw new ApiError("هذا الرقم لم يعد متاحًا", 409);

  let outcome;
  try {
    outcome = await ledger.withMongoTransaction(async (session) => {
      // Money plus a one-of-a-kind resource: the standalone-Mongo fallback
      // could charge a player and fail to deliver, so refuse to run without a
      // real transaction rather than risk it.
      if (!session) throw new Error("MONGO_TRANSACTIONS_REQUIRED");

      if (requestKey) {
        const seen = await WalletTransaction.findOne({
          userId,
          type: "special_id_purchase",
          "meta.requestKey": requestKey,
        })
          .select("_id meta")
          .session(session);
        if (seen) {
          return {
            duplicate: true,
            playerId: seen.meta?.number ?? n,
            previousPlayerId: seen.meta?.previousPlayerId ?? null,
            price: 0,
          };
        }
      }

      // Claim first. A second buyer hits a WriteConflict here, withTransaction
      // replays them, and on the replay `status: "listed"` no longer matches,
      // so they are rejected before touching their wallet at all.
      const claimed = await SpecialPlayerId.findOneAndUpdate(
        { number: n, status: "listed" },
        {
          $set: {
            status: "sold",
            owner: userId,
            acquiredVia: "purchase",
            soldAt: new Date(),
          },
        },
        { new: true, session }
      );
      if (!claimed) throw new ApiError("هذا الرقم لم يعد متاحًا", 409);

      // The price comes from the claimed document, never from the client.
      const price = claimed.price;
      const previousPlayerId =
        typeof user.playerId === "number" ? user.playerId : null;

      if (price > 0) {
        await ledger.ledgerWithdraw({
          session,
          userId,
          amount: price,
          ledgerType: "special_id_purchase",
          meta: { number: n, previousPlayerId, requestKey: requestKey || undefined },
        });
      }

      await SpecialPlayerId.updateOne(
        { _id: claimed._id },
        { $set: { soldPrice: price } },
        { session }
      );

      const assigned = await playerIdService.assignPlayerId({
        session,
        userId,
        number: n,
        reason: "special_purchase",
        meta: { boughtNumber: n },
      });

      // Upgrading off one vanity number destroys it: it is retired above, and
      // this takes it out of the store for good so it can never be relisted.
      if (
        previousPlayerId !== null &&
        previousPlayerId >= SPECIAL_ID_MIN &&
        previousPlayerId <= SPECIAL_ID_MAX
      ) {
        await SpecialPlayerId.updateOne(
          { number: previousPlayerId },
          { $set: { status: "retired", owner: null } },
          { session }
        );
      }

      return { duplicate: false, price, ...assigned };
    });
  } catch (err) {
    if (err?.message === "INSUFFICIENT_BALANCE") {
      throw new ApiError("رصيدك لا يكفي لشراء هذا الرقم", 402);
    }
    if (playerIdService.isDuplicateKey(err)) {
      throw new ApiError("هذا الرقم لم يعد متاحًا", 409);
    }
    throw err;
  }

  // Everything below is outside the transaction on purpose — see the file
  // header. The cache invalidation in particular is not optional: the profile
  // snapshot holds `identity` for 30s, so without it the buyer keeps seeing
  // their old number right after paying for a new one.
  playerProfileService.invalidate(userId);

  if (!outcome.duplicate) {
    await auditService
      .logEvent({
        event: "player_special_id_purchased",
        actor: userId,
        targetUser: userId,
        meta: {
          number: n,
          previousPlayerId: outcome.previousPlayerId,
          price: outcome.price,
        },
      })
      .catch((e) =>
        logger.warn("special_id_audit_failed", { reason: e?.message || "unknown" })
      );
  }

  return outcome;
}

/* ------------------------------------------------------------------ admin -- */

async function adminList({ status, page = 1, limit = 50 } = {}) {
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const filter = {};
  if (status) filter.status = String(status);

  const [rows, total] = await Promise.all([
    SpecialPlayerId.find(filter)
      .sort({ number: 1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean(),
    SpecialPlayerId.countDocuments(filter),
  ]);
  return { items: rows.map(adminView), total, page: pg, limit: lim };
}

async function adminListOne({ number, price, label, tier, actorId }) {
  const n = assertSpecialRange(number);
  const p = Number(price);
  if (!Number.isFinite(p) || p < 0) throw new ApiError("سعر غير صالح", 400);

  if (await playerIdService.isRetired(n)) {
    throw new ApiError("هذا الرقم متقاعد ولا يمكن عرضه", 409);
  }
  if (await User.exists({ playerId: n })) {
    throw new ApiError("هذا الرقم مملوك للاعب", 409);
  }

  const existing = await SpecialPlayerId.findOne({ number: n });
  if (existing && (existing.status === "sold" || existing.status === "retired")) {
    throw new ApiError("هذا الرقم لم يعد قابلاً للعرض", 409);
  }

  const doc = await SpecialPlayerId.findOneAndUpdate(
    { number: n },
    {
      $set: {
        price: p,
        status: "listed",
        label: label || null,
        tier: tier || null,
        updatedBy: actorId || null,
      },
      $setOnInsert: { listedBy: actorId || null },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return adminView(doc.toObject());
}

/**
 * List a whole range in one call. Numbers already sold, retired or held by a
 * player are skipped rather than failing the batch — an admin listing 101-200
 * should not have to know which handful are already gone.
 */
async function adminListRange({ from, to, price, tier, actorId }) {
  const start = assertSpecialRange(from);
  const end = assertSpecialRange(to);
  if (end < start) throw new ApiError("المدى غير صالح", 400);
  const p = Number(price);
  if (!Number.isFinite(p) || p < 0) throw new ApiError("سعر غير صالح", 400);

  const numbers = [];
  for (let n = start; n <= end; n += 1) numbers.push(n);

  const [taken, retired, blocked] = await Promise.all([
    User.find({ playerId: { $in: numbers } }).select("playerId").lean(),
    require("../models/retiredPlayerIdModel")
      .find({ number: { $in: numbers } })
      .select("number")
      .lean(),
    SpecialPlayerId.find({
      number: { $in: numbers },
      status: { $in: ["sold", "retired"] },
    })
      .select("number")
      .lean(),
  ]);

  const skip = new Set([
    ...taken.map((u) => u.playerId),
    ...retired.map((r) => r.number),
    ...blocked.map((b) => b.number),
  ]);
  const usable = numbers.filter((n) => !skip.has(n));
  if (usable.length === 0) {
    return { listed: 0, skipped: numbers.length };
  }

  await SpecialPlayerId.bulkWrite(
    usable.map((n) => ({
      updateOne: {
        filter: { number: n },
        update: {
          $set: {
            price: p,
            status: "listed",
            tier: tier || null,
            updatedBy: actorId || null,
          },
          $setOnInsert: { listedBy: actorId || null },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  return { listed: usable.length, skipped: numbers.length - usable.length };
}

async function adminUpdate({ number, price, label, tier, status, actorId }) {
  const n = assertSpecialRange(number);
  const doc = await SpecialPlayerId.findOne({ number: n });
  if (!doc) throw new ApiError("هذا الرقم غير موجود في الكتالوج", 404);
  if (doc.status === "sold") throw new ApiError("هذا الرقم مباع", 409);
  if (doc.status === "retired") throw new ApiError("هذا الرقم متقاعد", 409);

  if (price !== undefined) {
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) throw new ApiError("سعر غير صالح", 400);
    doc.price = p;
  }
  if (label !== undefined) doc.label = label || null;
  if (tier !== undefined) doc.tier = tier || null;
  if (status !== undefined) {
    if (!["listed", "withdrawn"].includes(status)) {
      throw new ApiError("حالة غير صالحة", 400);
    }
    doc.status = status;
  }
  doc.updatedBy = actorId || null;
  await doc.save();
  return adminView(doc.toObject());
}

module.exports = {
  SPECIAL_ID_MIN,
  SPECIAL_ID_MAX,
  listStore,
  getListed,
  purchaseSpecialId,
  adminList,
  adminListOne,
  adminListRange,
  adminUpdate,
  publicView,
  adminView,
};
