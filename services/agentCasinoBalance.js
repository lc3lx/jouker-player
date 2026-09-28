/**
 * The agent's selling float is not their playing chips.
 *
 * Casino balance lives on the agent profile and is what admin recharge,
 * player deposits, and direct credits move. The user wallet stays the
 * player's own chips for tables and slots.
 *
 * The first time an existing agent is touched, whatever is sitting in their
 * player wallet is moved into the casino purse once (`floatSeparated`),
 * because that wallet used to be the purse.
 */

const AgentProfile = require("../models/agentProfileModel");
const WalletTransaction = require("../models/walletTransactionModel");
const {
  getOrCreateWallet,
  ledgerWithdraw,
} = require("./walletLedgerService");

function sessionOpts(session) {
  return session ? { session } : {};
}

function casinoOf(profile) {
  return Math.max(0, Math.floor(Number(profile?.deposit?.casinoBalance) || 0));
}

/**
 * Move an unsplit player balance into the casino purse. Safe to call inside
 * the same Mongo transaction as the debit that spends it.
 */
async function separatePlayerAndCasino(profileId, session) {
  const claimed = await AgentProfile.findOneAndUpdate(
    { _id: profileId, "deposit.floatSeparated": { $ne: true } },
    { $set: { "deposit.floatSeparated": true } },
    { new: false, ...sessionOpts(session) }
  );
  if (!claimed) {
    return AgentProfile.findById(profileId).session(session || null);
  }

  const wallet = await getOrCreateWallet(claimed.user, session);
  const available = Math.max(0, Math.floor(Number(wallet.balance) || 0));
  if (available > 0) {
    await ledgerWithdraw({
      session,
      userId: claimed.user,
      amount: available,
      ledgerType: "withdraw",
      meta: { reason: "agent_casino_split" },
    });
    await AgentProfile.updateOne(
      { _id: profileId },
      { $inc: { "deposit.casinoBalance": available } },
      sessionOpts(session)
    );
  }
  return AgentProfile.findById(profileId).session(session || null);
}

async function writeCasinoLedger({ session, userId, type, amount, before, after, meta }) {
  await WalletTransaction.create(
    [
      {
        userId,
        type,
        amount,
        balanceBefore: before,
        balanceAfter: after,
        lockedBalanceBefore: 0,
        lockedBalanceAfter: 0,
        meta: { ...meta, purse: "casino" },
        createdAt: new Date(),
      },
    ],
    sessionOpts(session)
  );
}

/**
 * Add or remove casino chips. `delta` is signed. Throws INSUFFICIENT_BALANCE
 * when a debit would go below zero. Returns the casino balance after.
 */
async function changeCasinoBalance({
  session,
  profileId,
  delta,
  ledgerType,
  meta = {},
}) {
  const amount = Math.floor(Number(delta) || 0);
  if (!amount) throw new Error("INVALID_AMOUNT");

  const profile = await separatePlayerAndCasino(profileId, session);
  if (!profile) throw new Error("AGENT_NOT_FOUND");

  const before = casinoOf(profile);
  let after = before;
  if (amount > 0) {
    const updated = await AgentProfile.findOneAndUpdate(
      { _id: profileId },
      { $inc: { "deposit.casinoBalance": amount } },
      { new: true, ...sessionOpts(session) }
    );
    after = casinoOf(updated);
  } else {
    const spend = -amount;
    const updated = await AgentProfile.findOneAndUpdate(
      { _id: profileId, "deposit.casinoBalance": { $gte: spend } },
      { $inc: { "deposit.casinoBalance": -spend } },
      { new: true, ...sessionOpts(session) }
    );
    if (!updated) throw new Error("INSUFFICIENT_BALANCE");
    after = casinoOf(updated);
  }

  await writeCasinoLedger({
    session,
    userId: profile.user,
    type: ledgerType,
    amount: Math.abs(amount),
    before,
    after,
    meta,
  });
  return after;
}

module.exports = {
  casinoOf,
  separatePlayerAndCasino,
  changeCasinoBalance,
};
