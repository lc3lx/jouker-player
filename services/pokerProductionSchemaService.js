const HandHistory = require("../models/handHistoryModel");
const PokerHandCommit = require("../models/pokerHandCommitModel");
const PokerPostSettlementJob = require("../models/pokerPostSettlementJobModel");

/**
 * Financial idempotency depends on real database constraints. Mongoose's
 * `unique` option only declares an index, so production startup explicitly
 * validates existing data and installs the indexes before accepting traffic.
 */
async function ensurePokerProductionIndexes() {
  const duplicates = await HandHistory.aggregate([
    { $group: { _id: "$handId", count: { $sum: 1 } } },
    { $match: { _id: { $ne: null }, count: { $gt: 1 } } },
    { $limit: 1 },
  ]);
  if (duplicates.length > 0) {
    throw new Error(`POKER_DUPLICATE_HAND_ID:${duplicates[0]._id}`);
  }
  await HandHistory.syncIndexes();
  await PokerHandCommit.syncIndexes();
  await PokerPostSettlementJob.syncIndexes();
}

module.exports = { ensurePokerProductionIndexes };
