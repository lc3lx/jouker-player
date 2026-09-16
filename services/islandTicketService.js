const crypto = require('crypto');
const mongoose = require('mongoose');
const Member = require('../models/islandMemberModel');
const Ticket = require('../models/islandTicketModel');
const Pool = require('../models/islandPoolModel');
const Table = require('../models/tableModel');
const History = require('../models/islandHistoryModel');
const Transaction = require('../models/jackpotTransactionModel');
const ledger = require('./walletLedgerService');
const ApiError = require('../utils/apiError');
const { computePoolFlags } = require('../utils/islandJackpotLogic');
const { invalidateStatusCache } = require('../utils/islandJackpotCache');
const logger = require('../utils/logger');

async function requireSeat(userId, tableId) {
  if (!mongoose.isValidObjectId(tableId) || !await Table.exists({
    _id: tableId, gameType: 'poker', 'seats.user': userId,
  })) throw new ApiError('Sit at this poker table first', 403);
}

async function charge(userId, tableId, session, idempotencyKey) {
  if (!session) throw new Error('MONGO_TRANSACTIONS_REQUIRED');
  const pool = await Pool.findOne({ key: 'default' }).session(session);
  if (process.env.ISLAND_JACKPOT_ENABLED === 'false' || !pool?.enabled) {
    throw new ApiError('Island Jackpot is disabled', 403);
  }
  const fee = Math.trunc(pool.entryFee);
  if (!(fee > 0)) throw new Error('INVALID_ENTRY_FEE');
  const txnId = crypto.randomUUID();
  await ledger.ledgerWithdraw({ session, userId, amount: fee,
    ledgerType: 'island_jackpot_entry', meta: { txnId, tableId } });
  pool.poolBalance += fee;
  pool.stats.totalEntries += 1;
  pool.stats.peakPoolBalance = Math.max(pool.stats.peakPoolBalance, pool.poolBalance);
  Object.assign(pool, { armed: computePoolFlags(pool).armed,
    hotJackpot: computePoolFlags(pool).hotJackpot });
  pool.version += 1;
  await pool.save({ session });
  const [history] = await History.create([{ type: 'join', userId,
    amount: fee, poolAfter: pool.poolBalance, meta: { txnId, tableId } }], { session });
  await Transaction.create([{ txnId, userId, direction: 'debit_entry', amount: fee,
    islandHistoryId: history._id, status: 'completed',
    idempotencyKey: idempotencyKey || undefined, meta: { tableId } }], { session });
  return { fee, txnId };
}

async function buyNext(userId, tableId, requestKey) {
  await requireSeat(userId, tableId);
  await Pool.getSingleton();
  const key = requestKey ? `island:${userId}:${requestKey}` : null;
  await ledger.withMongoTransaction(async session => {
    if (!session) throw new Error('MONGO_TRANSACTIONS_REQUIRED');
    if (key && await Transaction.exists({ idempotencyKey: key }).session(session)) return;
    const member = await Member.findOneAndUpdate({ userId },
      { $setOnInsert: { userId } }, { upsert: true, new: true, session });
    if (member.pendingTableId) {
      if (member.pendingTableId !== String(tableId)) throw new ApiError('Ticket reserved at another table', 409);
      return;
    }
    const { fee, txnId } = await charge(userId, tableId, session, key);
    member.pendingTableId = String(tableId);
    member.pendingAt = new Date();
    member.pendingFee = fee;
    member.active = true;
    member.lastEntryTxnId = txnId;
    member.totalContributed += fee;
    await member.save({ session });
  });
  await invalidateStatusCache();
}

async function setAutoBuy(userId, tableId, enabled) {
  if (enabled) await requireSeat(userId, tableId);
  await Member.findOneAndUpdate({ userId }, { $set: {
    autoBuyTableId: enabled ? String(tableId) : '',
    autoBuySince: enabled ? new Date() : null,
  } }, { upsert: true });
}

// Called before any cards are revealed. A purchase after the cutoff belongs
// to the following hand; a unique ticket makes retries harmless.
async function prepareHand({ tableId, handId, userIds, startedAt }) {
  if (process.env.ISLAND_JACKPOT_ENABLED === 'false') return;
  const cutoff = new Date(startedAt);
  const members = await Member.find({ userId: { $in: userIds }, $or: [
    { pendingTableId: String(tableId), pendingAt: { $lte: cutoff } },
    { autoBuyTableId: String(tableId), autoBuySince: { $lte: cutoff } },
  ] }).lean();
  for (const original of members) {
    try {
      await ledger.withMongoTransaction(async session => {
        if (!session) throw new Error('MONGO_TRANSACTIONS_REQUIRED');
        if (await Ticket.exists({ userId: original.userId, handId }).session(session)) return;
        const member = await Member.findById(original._id).session(session);
        const prepaid = member.pendingTableId === String(tableId) && member.pendingAt <= cutoff;
        const automatic = member.autoBuyTableId === String(tableId) && member.autoBuySince <= cutoff;
        if (!prepaid && !automatic) return;
        let fee = member.pendingFee;
        if (!prepaid) {
          const result = await charge(member.userId, tableId, session, `island:auto:${member.userId}:${handId}`);
          fee = result.fee;
          member.totalContributed += fee;
          member.lastEntryTxnId = result.txnId;
        } else {
          member.pendingTableId = '';
          member.pendingAt = null;
          member.pendingFee = 0;
        }
        await Ticket.create([{ userId: member.userId, tableId: String(tableId), handId, amount: fee }], { session });
        await member.save({ session });
      });
    } catch (error) {
      if (error.message?.includes('INSUFFICIENT')) {
        await Member.updateOne({ _id: original._id, autoBuyTableId: String(tableId) },
          { $set: { autoBuyTableId: '', autoBuySince: null } });
      }
      logger.warn('island_ticket_hand_failed', { handId, userId: String(original.userId), message: error.message });
    }
  }
  await invalidateStatusCache();
}

async function personalStatus(userId, tableId, handId) {
  if (!userId) return { isMember: false, nextHandPurchased: false, autoBuy: false, currentHandPurchased: false };
  const member = await Member.findOne({ userId }).lean();
  const nextHandPurchased = !!member?.pendingTableId && (!tableId || member.pendingTableId === String(tableId));
  return {
    isMember: nextHandPurchased,
    nextHandPurchased,
    autoBuy: !!tableId && member?.autoBuyTableId === String(tableId),
    currentHandPurchased: !!handId && !!await Ticket.exists({ userId, tableId: String(tableId), handId: String(handId) }),
  };
}

module.exports = { buyNext, setAutoBuy, prepareHand, personalStatus };
