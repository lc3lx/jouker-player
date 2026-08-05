const PokerPostSettlementJob = require("../models/pokerPostSettlementJobModel");
const logger = require("../utils/logger");
const { sendAlert } = require("../utils/alert");

const PROCESSING_LEASE_MS = 5 * 60 * 1000;
// Escalate after this many attempts, but never abandon a reserved payout.
const MAX_ATTEMPTS = 20;
let scheduledTimer = null;
let scheduledForMs = 0;
let processing = false;

function retryDelayMs(attempts) {
  // 1s, 2s, 4s ... capped at five minutes. A durable failed row remains for
  // operations after the maximum is reached; it is never silently discarded.
  return Math.min(5 * 60 * 1000, 1000 * (2 ** Math.min(Math.max(attempts - 1, 0), 9)));
}

function schedulePokerPostSettlementProcessing(delayMs = 0) {
  const targetMs = Date.now() + Math.max(0, delayMs);
  // A fresh hand must not wait behind an older retry timer. Conversely, keep
  // the earlier timer when a later retry is scheduled.
  if (scheduledTimer && targetMs >= scheduledForMs) return;
  if (scheduledTimer) clearTimeout(scheduledTimer);
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null;
    scheduledForMs = 0;
    void processPokerPostSettlementJobs().catch((err) => {
      logger.error("poker_post_settlement_worker_failed", {
        reason: err?.message || "unknown",
      });
    });
  }, Math.max(0, targetMs - Date.now()));
  scheduledForMs = targetMs;
  // A pending retry must not keep a node alive during a graceful shutdown.
  scheduledTimer.unref?.();
}

async function enqueueIslandJackpotJob({ session = null, handId, handHistoryId, tableId, payload }) {
  if (!handId || !handHistoryId || !tableId) {
    throw new Error("POKER_POST_SETTLEMENT_JOB_INVALID");
  }

  await PokerPostSettlementJob.updateOne(
    { type: "island_jackpot", handId: String(handId) },
    {
      $setOnInsert: {
        type: "island_jackpot",
        handId: String(handId),
        table: tableId,
        handHistory: handHistoryId,
        payload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
      },
    },
    { upsert: true, ...(session ? { session } : {}) }
  );
}

async function claimNextJob() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  return PokerPostSettlementJob.findOneAndUpdate(
    {
      $or: [
        { status: "pending", nextAttemptAt: { $lte: now } },
        { status: "processing", lockedAt: { $lte: staleBefore } },
      ],
    },
    {
      $set: { status: "processing", lockedAt: now, lastError: "" },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1, createdAt: 1 } }
  ).lean();
}

async function finishJob(job) {
  if (job.type !== "island_jackpot") throw new Error(`UNKNOWN_POKER_JOB:${job.type}`);
  const result = await require("./islandJackpotService").onHandSettled(job.payload || {});

  // A Redis payout lock is held by another node. Keep the outbox pending;
  // the global winner/index guards make retries safe even after a crash.
  if (result?.status === "deferred") {
    throw new Error("ISLAND_JACKPOT_LOCK_BUSY");
  }
}

async function processPokerPostSettlementJobs({ limit = 10 } = {}) {
  if (processing) return { processed: 0, busy: true };
  processing = true;
  let processed = 0;
  let earliestRetryAt = null;

  try {
    while (processed < Math.max(1, limit)) {
      const job = await claimNextJob();
      if (!job) break;
      processed += 1;

      try {
        await finishJob(job);
        await PokerPostSettlementJob.updateOne(
          { _id: job._id, status: "processing", lockedAt: job.lockedAt },
          {
            $set: {
              status: "completed",
              completedAt: new Date(),
              lockedAt: null,
              lastError: "",
            },
          }
        );
      } catch (err) {
        const attempts = Number(job.attempts || 1);
        const escalated = attempts >= MAX_ATTEMPTS;
        const nextAttemptAt = new Date(Date.now() + retryDelayMs(attempts));
        await PokerPostSettlementJob.updateOne(
          { _id: job._id, status: "processing", lockedAt: job.lockedAt },
          {
            $set: {
              status: "pending",
              lockedAt: null,
              nextAttemptAt,
              lastError: String(err?.message || "unknown").slice(0, 500),
            },
          }
        );
        logger[escalated ? "error" : "warn"]("poker_post_settlement_job_failed", {
          jobId: String(job._id),
          type: job.type,
          handId: job.handId,
          attempts,
          terminal: false,
          escalated,
          reason: err?.message || "unknown",
        });
        if (escalated && attempts % MAX_ATTEMPTS === 0) {
          void sendAlert("poker_post_settlement_job_terminal_failure", {
            jobId: String(job._id),
            type: job.type,
            handId: job.handId,
            attempts,
            reason: err?.message || "unknown",
          });
        }
        if (!earliestRetryAt || nextAttemptAt < earliestRetryAt) {
          earliestRetryAt = nextAttemptAt;
        }
      }
    }
  } finally {
    processing = false;
  }

  if (processed >= Math.max(1, limit)) schedulePokerPostSettlementProcessing(0);
  if (earliestRetryAt) {
    schedulePokerPostSettlementProcessing(Math.max(0, earliestRetryAt.getTime() - Date.now()));
  }
  return { processed, busy: false };
}

async function resumePokerPostSettlementJobs() {
  const now = Date.now();
  const staleBefore = new Date(now - PROCESSING_LEASE_MS);
  const recoverable = await PokerPostSettlementJob.countDocuments({
    status: { $in: ["pending", "processing"] },
  });
  if (recoverable > 0) {
    const [nextPending, staleProcessing] = await Promise.all([
      PokerPostSettlementJob.findOne({ status: "pending" })
        .sort({ nextAttemptAt: 1 })
        .select("nextAttemptAt")
        .lean(),
      PokerPostSettlementJob.exists({ status: "processing", lockedAt: { $lte: staleBefore } }),
    ]);
    const delayMs = staleProcessing || !nextPending
      ? 0
      : Math.max(0, new Date(nextPending.nextAttemptAt).getTime() - now);
    schedulePokerPostSettlementProcessing(delayMs);
  }
  return { resumed: recoverable };
}

module.exports = {
  MAX_ATTEMPTS,
  PROCESSING_LEASE_MS,
  enqueueIslandJackpotJob,
  processPokerPostSettlementJobs,
  resumePokerPostSettlementJobs,
  retryDelayMs,
  schedulePokerPostSettlementProcessing,
};
