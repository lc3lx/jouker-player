"use strict";
const { randomUUID } = require("crypto");
const Table = require("../models/tableModel");
const Wallet = require("../models/walletModel");
const { withMongoTransaction, transferToLocked } = require("./walletLedgerService");
const { validBuyIn } = require("../utils/poker/buyInPolicy");

const REBUY_WINDOW_MS = 60000;
const uid = (seat) => String(seat.user?._id || seat.user);
const cashTable = (table) => table.gameType === "poker" && table.tableKind !== "tournament" &&
  !table.arenaTournament && !table.clanTournamentMatch;

async function offerRebuy(tableId, userId, now = Date.now()) {
  let result = null;
  await withMongoTransaction(async (session) => {
    const table = await Table.findById(tableId).session(session);
    if (!table || !cashTable(table)) return;
    const seat = table.seats.find((s) => uid(s) === String(userId));
    if (!seat || seat.chips !== 0) return;
    if ((table.pendingPermanentLeaves || []).some((s) => uid(s) === String(userId))) return;
    if (seat.rebuyOffer?.status === "pending") {
      result = seat.rebuyOffer.toObject ? seat.rebuyOffer.toObject() : { ...seat.rebuyOffer };
      result.minBuyIn = table.minBuyIn; result.maxBuyIn = table.maxBuyIn;
      return;
    }
    // A terminal offer on a zero stack must be cashed out, never renewed.
    if (["expired", "cancelled"].includes(seat.rebuyOffer?.status)) {
      result = { exit: true }; return;
    }
    const wallet = await Wallet.findOne({ user: userId }).session(session);
    if (!wallet || wallet.balance < table.minBuyIn) { result = { exit: true }; return; }
    seat.rebuyOffer = { offerId: randomUUID(), expiresAt: new Date(now + REBUY_WINDOW_MS), status: "pending" };
    await table.save({ session });
    result = seat.rebuyOffer.toObject ? seat.rebuyOffer.toObject() : { ...seat.rebuyOffer };
    result.minBuyIn = table.minBuyIn; result.maxBuyIn = table.maxBuyIn;
  });
  return result;
}

async function confirmRebuy({ tableId, userId, offerId, actionId, amount, cancel = false, now = Date.now(), ownerFence = 0 }) {
  if (typeof actionId !== "string" || !actionId.trim() || actionId.length > 128) throw new Error("MISSING_ACTION_ID");
  let result;
  await withMongoTransaction(async (session) => {
    // Rebuy money requires a real transaction, including on development Mongo.
    if (!session) throw new Error("REBUY_REQUIRES_TRANSACTION");
    const table = await Table.findById(tableId).session(session);
    if (!table || !cashTable(table)) throw new Error("NOT_CASH_POKER");
    if (ownerFence > 0 && table.pokerOwnerFence > ownerFence) throw new Error("POKER_FENCE_LOST");
    const seat = table.seats.find((s) => uid(s) === String(userId));
    if (!seat) throw new Error("SEAT_NOT_FOUND");
    const offer = seat.rebuyOffer;
    if (!offer || offer.offerId !== offerId) throw new Error("INVALID_OFFER");
    if (offer.status === "accepted" && offer.actionId === actionId && offer.amount === amount) {
      result = { status: "accepted", amount, duplicate: true }; return;
    }
    if (offer.status !== "pending") throw new Error("INVALID_OFFER");
    if ((table.pendingPermanentLeaves || []).some((s) => uid(s) === String(userId))) throw new Error("LEAVE_PENDING");
    if (seat.chips !== 0) throw new Error("INVALID_STACK");
    const wallet = await Wallet.findOne({ user: userId }).session(session);
    if (!wallet || wallet.balance < table.minBuyIn) {
      offer.status = "cancelled"; offer.actionId = actionId;
      await table.save({ session });
      result = { status: "cancelled", exit: true }; return;
    }
    if (cancel || new Date(offer.expiresAt).getTime() <= now) {
      offer.status = cancel ? "cancelled" : "expired";
      offer.actionId = actionId;
      await table.save({ session });
      result = { status: offer.status, exit: true }; return;
    }
    if (!validBuyIn(amount, table.minBuyIn, table.maxBuyIn)) throw new Error("INVALID_BUYIN");
    await transferToLocked({ session, userId, tableId, amount,
      meta: { reason: "manual_rebuy", offerId, actionId } });
    seat.chips = amount;
    offer.status = "accepted"; offer.actionId = actionId; offer.amount = amount;
    await table.save({ session });
    result = { status: "accepted", amount };
  });
  return result;
}
module.exports = { REBUY_WINDOW_MS, offerRebuy, confirmRebuy };
