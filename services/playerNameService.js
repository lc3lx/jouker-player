"use strict";

/**
 * Paid display-name changes.
 *
 * A player may rename themselves three times, for 1M / 5M / 10M chips, and
 * never again. Until now `PUT /users/updateMe` let anyone rename for free as
 * often as they liked — closing that hole is part of this feature, not a
 * separate cleanup (see userService.updateLoggedUserData).
 *
 * The slot is claimed with a single `$inc` guarded by `nameChangeCount < MAX`,
 * and the PRE-image of that update tells us which slot was consumed. That is
 * what makes a double-submit safe: two concurrent requests take two different
 * slots and are charged two different prices, rather than both reading "0 used"
 * and renaming twice for one fee.
 */

const ApiError = require("../utils/apiError");
const logger = require("../utils/logger");
const User = require("../models/userModel");
const Player = require("../models/playerModel");
const ClanMember = require("../models/clanMemberModel");
const WalletTransaction = require("../models/walletTransactionModel");
const auditService = require("./auditService");
const playerProfileService = require("./playerProfileService");
const { withMongoTransaction, ledgerWithdraw } = require("./walletLedgerService");

/**
 * Deliberately constants, not env vars. These are product numbers; an
 * environment that drifted would quietly charge the wrong price, and there is
 * no operational reason to vary them per deployment.
 */
const RENAME_PRICES = [1_000_000, 5_000_000, 10_000_000];
const MAX_NAME_CHANGES = RENAME_PRICES.length;

const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 20;

/** Bidi overrides and zero-width characters. */
const INVISIBLE_RE = /[​-‏‪-‮⁦-⁩﻿]/;

/**
 * Arabic and Latin letters, digits, space and a few separators.
 *
 * `ً-ٰٟ` is not decoration: Arabic diacritics (fatha, shadda,
 * sukun, superscript alef…) are combining marks, and a combining mark's script
 * property is `Inherited`, NOT `Arabic`. Without them `\p{Script=Arabic}`
 * rejects every vocalized Arabic name — "المحدّث" fails on the shadda alone.
 * Listing the tashkeel block explicitly keeps them in without opening the door
 * to general combining marks from every other script.
 */
const ALLOWED_RE =
  /^[\p{Script=Arabic}ً-ٰٟ\p{Script=Latin}0-9 _.\-]+$/u;

const RESERVED = [
  "admin",
  "administrator",
  "support",
  "official",
  "moderator",
  "مدير",
  "الادارة",
  "الإدارة",
  "الدعم",
  "رسمي",
];

/**
 * Normalize and validate a requested display name.
 *
 * Returns the cleaned name; throws ApiError(400) with an Arabic message the UI
 * can show as-is.
 */
function validateDisplayName(raw) {
  if (raw === undefined || raw === null) throw new ApiError("الاسم مطلوب", 400);

  // NFC first: decomposed Arabic diacritics would otherwise inflate the length
  // and make two visually identical names compare as different.
  const name = String(raw).normalize("NFC").trim().replace(/\s+/g, " ");

  if (!name) throw new ApiError("الاسم مطلوب", 400);

  if (INVISIBLE_RE.test(name)) {
    // A right-to-left override lets a name render across neighbouring UI or
    // impersonate another player's, so this is a hard reject.
    throw new ApiError("الاسم يحتوي على محارف غير مسموحة", 400);
  }

  // Code points, not UTF-16 units: an emoji or any surrogate pair would
  // otherwise count as two characters.
  const length = [...name].length;
  if (length < MIN_NAME_LENGTH) {
    throw new ApiError(`الاسم قصير جداً (الحد الأدنى ${MIN_NAME_LENGTH} أحرف)`, 400);
  }
  if (length > MAX_NAME_LENGTH) {
    throw new ApiError(`الاسم طويل جداً (الحد الأقصى ${MAX_NAME_LENGTH} حرفاً)`, 400);
  }

  if (!ALLOWED_RE.test(name)) {
    throw new ApiError("الاسم يحتوي على رموز غير مسموحة", 400);
  }

  // An all-digit name would read as a player number in every list and chat
  // line, which is exactly the identity this release is introducing.
  if (/^[\p{Nd}]+$/u.test(name)) {
    throw new ApiError("لا يمكن أن يتكون الاسم من أرقام فقط", 400);
  }

  const folded = name.toLowerCase();
  if (RESERVED.some((word) => folded.includes(word))) {
    throw new ApiError("هذا الاسم محجوز", 400);
  }

  return name;
}

/** What the next rename costs, and how many are left. */
async function getQuote(userId) {
  const user = await User.findById(userId).select("name nameChangeCount").lean();
  if (!user) throw new ApiError("اللاعب غير موجود", 404);
  const used = Math.min(user.nameChangeCount || 0, MAX_NAME_CHANGES);
  return {
    currentName: user.name,
    used,
    remaining: MAX_NAME_CHANGES - used,
    prices: [...RENAME_PRICES],
    nextPrice: used < MAX_NAME_CHANGES ? RENAME_PRICES[used] : null,
    maxChanges: MAX_NAME_CHANGES,
    minLength: MIN_NAME_LENGTH,
    maxLength: MAX_NAME_LENGTH,
  };
}

async function changeName({ userId, name: rawName, requestKey }) {
  const name = validateDisplayName(rawName);

  const current = await User.findById(userId).select("name nameChangeCount active").lean();
  if (!current) throw new ApiError("اللاعب غير موجود", 404);
  if (current.active === false) throw new ApiError("الحساب موقوف", 403);

  // Renaming to the same name is a no-op, not a purchase. This alone absorbs
  // the most common accidental double-submit.
  if (current.name === name) {
    return { name, charged: 0, used: current.nameChangeCount || 0, duplicate: true };
  }

  let outcome;
  try {
    outcome = await withMongoTransaction(async (session) => {
      if (!session) throw new Error("MONGO_TRANSACTIONS_REQUIRED");

      if (requestKey) {
        const seen = await WalletTransaction.findOne({
          userId,
          type: "name_change_fee",
          "meta.requestKey": requestKey,
        })
          .select("_id meta")
          .session(session);
        if (seen) {
          return { name: seen.meta?.to ?? name, charged: 0, duplicate: true };
        }
      }

      // Claim any remaining slot atomically. `new: false` is the point: the
      // pre-image says which slot we just took, so the price cannot be derived
      // from a read that another request has already invalidated.
      //
      // The `$exists: false` arm is not belt-and-braces — `$lt` does NOT match
      // a document that lacks the field, and every account created before this
      // feature shipped lacks it (a mongoose default only applies to documents
      // mongoose itself creates). Without this arm the claim matches nobody and
      // the entire existing player base is told it has used up all three
      // changes.
      const pre = await User.findOneAndUpdate(
        {
          _id: userId,
          $or: [
            { nameChangeCount: { $lt: MAX_NAME_CHANGES } },
            { nameChangeCount: { $exists: false } },
          ],
        },
        { $inc: { nameChangeCount: 1 } },
        { new: false, session }
      );
      if (!pre) throw new ApiError("لقد استنفدت جميع مرات تغيير الاسم", 409);

      const slot = pre.nameChangeCount || 0;
      const price = RENAME_PRICES[slot];

      await ledgerWithdraw({
        session,
        userId,
        amount: price,
        ledgerType: "name_change_fee",
        meta: {
          slot: slot + 1,
          from: pre.name,
          to: name,
          requestKey: requestKey || undefined,
        },
      });

      await User.updateOne(
        { _id: userId },
        { $set: { name, nameChangedAt: new Date() } },
        { session }
      );

      // The two denormalized copies of the name. Anything else reads User.name
      // live, so this is the whole list.
      await Player.updateOne(
        { user: userId },
        { $set: { displayName: name } },
        { session }
      );
      await ClanMember.updateOne(
        { user: userId },
        { $set: { displayName: name } },
        { session }
      );

      return {
        name,
        charged: price,
        slot: slot + 1,
        used: slot + 1,
        remaining: MAX_NAME_CHANGES - (slot + 1),
        previousName: pre.name,
        duplicate: false,
      };
    });
  } catch (err) {
    if (err?.message === "INSUFFICIENT_BALANCE") {
      throw new ApiError("رصيدك لا يكفي لتغيير الاسم", 402);
    }
    if (err?.message === "MONGO_TRANSACTIONS_REQUIRED") {
      // A bare Error carries no status, so this reached the client as an
      // opaque 500 with nothing to act on. It means the database is not a
      // replica set, which is an operator problem, not a player one — say so
      // in the log and give the player something that isn't a blank failure.
      logger.error("name_change_requires_transactions", {
        userId: String(userId),
        hint: "mongod must run as a replica set for money operations",
      });
      throw new ApiError("الخدمة غير متاحة حالياً، حاول لاحقاً", 503);
    }
    throw err;
  }

  playerProfileService.invalidate(userId);

  if (!outcome.duplicate) {
    await auditService
      .logEvent({
        event: "player_name_changed",
        actor: userId,
        targetUser: userId,
        meta: {
          from: outcome.previousName,
          to: outcome.name,
          slot: outcome.slot,
          price: outcome.charged,
        },
      })
      .catch((e) =>
        logger.warn("name_change_audit_failed", { reason: e?.message || "unknown" })
      );
  }

  return outcome;
}

module.exports = {
  RENAME_PRICES,
  MAX_NAME_CHANGES,
  MIN_NAME_LENGTH,
  MAX_NAME_LENGTH,
  validateDisplayName,
  getQuote,
  changeName,
};
