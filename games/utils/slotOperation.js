"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const ApiError = require("../../utils/apiError");
const logger = require("../../utils/logger");
const context = new AsyncLocalStorage();
const receipts = new Map();

function currentSession() { return context.getStore()?.session || null; }
function active() { return !!context.getStore(); }
function withContext(session, jobs, work) { return context.run({ session, afterCommit: jobs }, work); }
function afterCommit(work) {
  const pending = context.getStore()?.afterCommit;
  if (pending) pending.push(work);
  else work();
}
async function walletTransaction(work) {
  const session = currentSession();
  return session ? work(session) : require("../../services/walletLedgerService").withMongoTransaction(work);
}

async function run({ game, userId, wallet, manager, modelName, requestId, input }, work) {
  const user = String(userId);
  if (requestId != null && (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId))) throw new ApiError("Invalid requestId", 400);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const key = JSON.stringify([game, user, requestId]);
  const startedAt = Date.now();
  const completed = await wallet.withUserLock(user, async () => {
    const mongo = wallet.MODE === "mongo";
    async function execute(session) {
      const Receipt = mongo ? require("../../models/slotOperationModel") : null;
      const Model = mongo ? require(`../../models/${modelName}`) : null;
      const cached = manager.getBonusSession(user);
      const previous = cached ? structuredClone(cached) : null;
      const balanceBefore = mongo ? null : await wallet.getBalance(user);
      let doc;
      try {
        if (requestId) {
          const receipt = mongo ? await Receipt.findOne({ game, userId: user, requestId }).session(session).lean() : receipts.get(key);
          if (receipt) {
            if (receipt.fingerprint !== fingerprint) throw new ApiError("requestId already used with different input", 409);
            return { response: structuredClone(receipt.response), jobs: [] };
          }
        }
        if (mongo) {
          doc = await Model.findOne({ userId: user }).session(session).lean();
          manager.replaceBonusSession(user, doc && doc.freeSpinsRemaining > 0 ? doc : null);
        }
        const jobs = [];
        const result = await context.run({ session, afterCommit: jobs }, work);
        const next = manager.getBonusSession(user);
        if (mongo) {
          const query = doc ? { userId: user, $or: [{ revision: doc.revision || 0 }, ...(doc.revision ? [] : [{ revision: { $exists: false } }])] } : { userId: user };
          if (next) {
            const snapshot = { ...next, revision: (doc?.revision || 0) + 1, updatedAt: Date.now() };
            delete snapshot._id; delete snapshot.__v;
            const saved = await Model.updateOne(query, { $set: snapshot }, { session, upsert: !doc });
            if (doc && saved.matchedCount !== 1) throw new Error("BONUS_SESSION_CHANGED");
            manager.replaceBonusSession(user, snapshot);
          } else if (doc) {
            const deleted = await Model.deleteOne(query, { session });
            if (deleted.deletedCount !== 1) throw new Error("BONUS_SESSION_CHANGED");
          }
          if (requestId) await Receipt.create([{ game, userId: user, requestId, fingerprint, response: result }], { session });
        } else if (requestId) receipts.set(key, { fingerprint, response: structuredClone(result) });
        return { response: result, jobs };
      } catch (err) {
        manager.replaceBonusSession(user, previous ? structuredClone(previous) : null);
        if (!mongo) wallet.seedStubBalance(user, balanceBefore);
        throw err;
      }
    }
    let completed;
    if (!mongo) completed = await execute(null);
    else {
    try {
      completed = await require("../../services/walletLedgerService").withMongoTransaction(async session => {
        if (!session) throw new Error("MONGO_TRANSACTIONS_REQUIRED_FOR_SLOTS");
        return execute(session);
      });
    } catch (err) {
      manager.replaceBonusSession(user, null); // never reuse an aborted transaction's cache
      throw err;
    }
    }
    return completed;
  }).catch((err) => {
    logger.warn("slot_operation_failed", {
      game, userId: user, requestId, elapsedMs: Date.now() - startedAt,
      reason: err?.message || "unknown",
    });
    throw err;
  });
  // Settlement and its receipt are committed. Notifications/telemetry must
  // neither retain the wallet lock nor delay delivery of the paid result.
  for (const job of completed.jobs) {
    try {
      Promise.resolve(job()).catch((err) => {
        console.error("slot post-commit telemetry failed", err.message);
      });
    } catch (err) {
      console.error("slot post-commit telemetry failed", err.message);
    }
  }
  return completed.response;
}

function clearForTests() { receipts.clear(); }
module.exports = { run, currentSession, active, afterCommit, walletTransaction, clearForTests, withContext };
