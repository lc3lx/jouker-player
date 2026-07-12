const crypto = require("crypto");
const mongoose = require("mongoose");
const GameSettlement = require("../models/gameSettlementModel");
const Table = require("../models/tableModel");
const ParkourRace = require("../models/parkourRaceModel");
const WalletTransaction = require("../models/walletTransactionModel");
const logger = require("../utils/logger");
const {
  withMongoTransaction,
  applyGameSettlementDelta,
  releaseTableSeatToBalance,
  setTableLockAmount,
  recordGameBuyinLedger,
  recordSettlementLedger,
  applyHouseSettlementDelta,
  assertHouseWalletReady,
  forfeitTableSeatLock,
} = require("./walletLedgerService");

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function getRakePercent(gameType) {
  const envKey = `GAME_RAKE_PERCENT_${String(gameType || "").toUpperCase()}`;
  const specific = parseFloat(process.env[envKey]);
  if (Number.isFinite(specific) && specific >= 0 && specific <= 100) return specific;
  const global = parseFloat(process.env.GAME_RAKE_PERCENT || "5");
  return Number.isFinite(global) ? Math.max(0, Math.min(100, global)) : 5;
}

/** @returns {number[]} seat indices that won */
function resolveWinnerSeatIndices(gameType, gameResult, seatCount = 4) {
  if (!gameResult) return [];

  if (gameType === "trix") {
    const scores = gameResult.scores || [];
    if (!scores.length) {
      if (gameResult.winnerIndex != null) return [gameResult.winnerIndex];
      return [];
    }
    let maxScore = -Infinity;
    for (let i = 0; i < seatCount; i++) {
      const s = toSafeInt(scores[i], 0);
      if (s > maxScore) maxScore = s;
    }
    const winners = [];
    for (let i = 0; i < seatCount; i++) {
      if (toSafeInt(scores[i], 0) === maxScore) winners.push(i);
    }
    return winners;
  }

  if (gameType === "tarneeb41") {
    const winnerTeam = gameResult.winnerTeam;
    if (winnerTeam !== 0 && winnerTeam !== 1) return [];
    const winners = [];
    for (let i = 0; i < seatCount; i++) {
      if (i % 2 === winnerTeam) winners.push(i);
    }
    return winners;
  }

  if (gameType === "poker" && Array.isArray(gameResult.winnerSeatIndices)) {
    return gameResult.winnerSeatIndices.map((i) => toSafeInt(i, -1)).filter((i) => i >= 0);
  }

  if (gameType === "parkour" && Array.isArray(gameResult.finishers)) {
    return gameResult.finishers.map((f) => toSafeInt(f.seatIndex, -1)).filter((i) => i >= 0);
  }

  if (gameResult.winnerIndex != null) return [toSafeInt(gameResult.winnerIndex, 0)];
  return [];
}

/**
 * Build settlement plan from table seats + game result.
 * Economy rules:
 * - Pool is all seat buy-ins (humans + bots).
 * - Bots never receive wallet payouts.
 * - House wallet is counterparty for bot economy + rake.
 */
function buildSettlementPlan({ gameType, gameResult, participants, rakePercent }) {
  const seats = Array.isArray(participants) ? participants : [];
  const winnerSeats = resolveWinnerSeatIndices(gameType, gameResult, seats.length || 4);
  const winnerSet = new Set(winnerSeats);

  const humanSeats = seats.filter((s) => !s.isBot && s.userId);
  const botSeats = seats.filter((s) => !!s.isBot);
  const totalHumanBuyIn = humanSeats.reduce((sum, s) => sum + toSafeInt(s.buyIn, 0), 0);
  const totalBotBuyIn = botSeats.reduce((sum, s) => sum + toSafeInt(s.buyIn, 0), 0);
  const totalBuyIn = totalHumanBuyIn + totalBotBuyIn;
  const rakePct = Math.max(0, Math.min(100, Number(rakePercent) || 0));
  let totalRake = Math.floor((totalBuyIn * rakePct) / 100);
  let payoutPool = Math.max(0, totalBuyIn - totalRake);

  const winnerSeatsAll = seats.filter((s) => winnerSet.has(s.seatIndex));
  const winnerCount = winnerSeatsAll.length;

  const virtualPayoutBySeat = new Map();

  // Parkour: weighted payout by finish order
  if (gameType === "parkour" && Array.isArray(gameResult.finishers) && winnerCount > 0) {
    const weights = gameResult.positionWeights || [10, 6, 4, 3, 2, 2, 1, 1, 1, 1];
    const finishers = [...gameResult.finishers].sort((a, b) => a.finishOrder - b.finishOrder);
    let weightSum = 0;
    const weightBySeat = new Map();
    for (const f of finishers) {
      const w = weights[Math.min(f.finishOrder - 1, weights.length - 1)] || 1;
      weightBySeat.set(f.seatIndex, w);
      weightSum += w;
    }
    let allocated = 0;
    finishers.forEach((f, idx) => {
      const w = weightBySeat.get(f.seatIndex) || 1;
      const share =
        idx === finishers.length - 1
          ? payoutPool - allocated
          : Math.floor((payoutPool * w) / weightSum);
      allocated += share;
      virtualPayoutBySeat.set(f.seatIndex, share);
    });
  } else {
    // No winner: entire pool is house revenue.
    if (winnerCount === 0 && totalBuyIn > 0) {
      totalRake = totalBuyIn;
      payoutPool = 0;
    }

    let perWinner = 0;
    let remainder = 0;
    if (winnerCount > 0 && payoutPool > 0) {
      perWinner = Math.floor(payoutPool / winnerCount);
      remainder = payoutPool - perWinner * winnerCount;
    }

    winnerSeatsAll.forEach((s, idx) => {
      const extra = idx === 0 ? remainder : 0;
      virtualPayoutBySeat.set(s.seatIndex, perWinner + extra);
    });
  }

  const planParticipants = seats.map((s) => {
    const buyIn = toSafeInt(s.buyIn, 0);
    const isWinner = winnerSet.has(s.seatIndex);
    const virtualPayout = virtualPayoutBySeat.get(s.seatIndex) || 0;
    const payout = s.isBot ? 0 : virtualPayout;
    const rakeShare = 0;
    const netDelta = s.isBot ? 0 : payout - buyIn;
    return {
      userId: s.userId,
      seatIndex: s.seatIndex,
      buyIn,
      virtualPayout,
      payout,
      netDelta,
      rakeShare,
      isWinner,
      isBot: !!s.isBot,
      vacatedUserId: s.vacatedUserId || null,
    };
  });

  const totalHumanPayout = planParticipants.reduce((sum, p) => sum + (p.isBot ? 0 : p.payout), 0);
  const totalBotPayout = planParticipants.reduce((sum, p) => sum + (p.isBot ? p.virtualPayout : 0), 0);
  const humanNetDelta = totalHumanPayout - totalHumanBuyIn;
  const houseNetDelta = -humanNetDelta;
  const winners = planParticipants
    .filter((p) => p.isWinner)
    .map((p) => ({
      userId: p.userId,
      seatIndex: p.seatIndex,
      payout: p.payout,
      isBot: p.isBot,
    }));

  return {
    rakePercent: rakePct,
    totalHumanBuyIn,
    totalBotBuyIn,
    totalBuyIn,
    totalRake,
    totalPayout: totalHumanPayout,
    totalHumanPayout,
    totalBotPayout,
    houseNetDelta,
    participants: planParticipants,
    winners,
    winnerSeatIndices: winnerSeats,
  };
}

function validateReconciliation(plan) {
  const hasHouseFields =
    plan &&
    (Object.prototype.hasOwnProperty.call(plan, "totalHumanBuyIn") ||
      Object.prototype.hasOwnProperty.call(plan, "houseNetDelta"));
  if (!hasHouseFields) {
    const totalBuyInsLegacy = toSafeInt(plan.totalBuyIn, 0);
    const winnersPayoutsLegacy = toSafeInt(plan.totalPayout, 0);
    const rakeLegacy = toSafeInt(plan.totalRake, 0);
    const deltaLegacy = totalBuyInsLegacy - (winnersPayoutsLegacy + rakeLegacy);
    return {
      totalBuyIns: totalBuyInsLegacy,
      totalHumanBuyIns: totalBuyInsLegacy,
      winnersPayouts: winnersPayoutsLegacy,
      rake: rakeLegacy,
      houseNetDelta: toSafeInt(plan.houseNetDelta, 0),
      humanNetDelta: winnersPayoutsLegacy - totalBuyInsLegacy,
      balanced: deltaLegacy === 0,
      delta: deltaLegacy,
    };
  }

  const totalHumanBuyIns = toSafeInt(plan.totalHumanBuyIn, 0);
  const winnersPayouts = toSafeInt(plan.totalHumanPayout ?? plan.totalPayout, 0);
  const rake = toSafeInt(plan.totalRake, 0);
  const humanNetDelta = winnersPayouts - totalHumanBuyIns;
  const houseNetDelta = toSafeInt(plan.houseNetDelta, -humanNetDelta);
  const delta = houseNetDelta + humanNetDelta;
  return {
    totalBuyIns: toSafeInt(plan.totalBuyIn, 0),
    totalHumanBuyIns,
    winnersPayouts,
    rake,
    houseNetDelta,
    humanNetDelta,
    balanced: delta === 0,
    delta,
  };
}

function buildIdempotencyKey({ tableId, gameType, sessionId, gameResult }) {
  const sid = sessionId || "no-session";
  const sig =
    gameResult && typeof gameResult === "object"
      ? JSON.stringify({
          w: gameResult.winnerIndex,
          wt: gameResult.winnerTeam,
          sc: gameResult.scores,
          ps: gameResult.playerScores,
          wsi: Array.isArray(gameResult.winnerSeatIndices)
            ? [...gameResult.winnerSeatIndices].sort((a, b) => a - b)
            : undefined,
          pot: gameResult.pot,
          hid: gameResult.handId,
        })
      : "unknown";
  return `${String(tableId)}:${gameType}:${sid}:${crypto.createHash("sha256").update(sig).digest("hex").slice(0, 16)}`;
}

function participantsFromTableAndGame(table, gamePlayers) {
  const playerBySeat = new Map();
  if (Array.isArray(gamePlayers)) {
    for (const p of gamePlayers) {
      playerBySeat.set(toSafeInt(p.seatIndex, playerBySeat.size), p);
    }
  }

  return table.seats.map((seat, idx) => {
    const uid = seat.user && seat.user._id ? seat.user._id : seat.user;
    const gp = playerBySeat.get(idx);
    const isBot = gp ? !!gp.isBot : false;
    return {
      userId: isBot ? null : uid,
      seatIndex: idx,
      buyIn: toSafeInt(seat.chips, 0),
      isBot,
      // Seat converted to a bot mid-game (engine marks vacatedFromUserId) — the
      // vacated human's locked buy-in is forfeited during settlement (never paid out).
      vacatedUserId: isBot && gp?.vacatedFromUserId ? gp.vacatedFromUserId : null,
    };
  });
}

async function participantSettlementAlreadyApplied(settlementId, userId, session) {
  const q = WalletTransaction.findOne({
    handId: settlementId,
    userId,
    type: "settlement",
  });
  const existing = await (session ? q.session(session) : q);
  return !!existing;
}

async function isTableSettlementBlocked(tableId) {
  const table = await Table.findById(tableId).select("activeSettlementId").lean();
  if (table?.activeSettlementId) {
    const active = await GameSettlement.findOne({
      settlementId: table.activeSettlementId,
      settlementStatus: "pending",
    }).lean();
    if (active) return true;
  }
  const pending = await GameSettlement.findOne({ tableId, settlementStatus: "pending" }).lean();
  return !!pending;
}

async function acquireTableSettlementLock(tableId, settlementId, session) {
  const q = Table.findOneAndUpdate(
    { _id: tableId, activeSettlementId: null },
    { $set: { activeSettlementId: settlementId } },
    { new: true }
  );
  const updated = await (session ? q.session(session) : q);
  if (updated) return true;

  const table = await Table.findById(tableId).session(session || null);
  if (!table?.activeSettlementId) return false;
  const existing = await GameSettlement.findOne({
    settlementId: table.activeSettlementId,
    settlementStatus: "completed",
  }).session(session || null);
  if (existing) {
    await Table.findByIdAndUpdate(tableId, { $set: { activeSettlementId: null } }).session(
      session || null
    );
    return acquireTableSettlementLock(tableId, settlementId, session);
  }
  return false;
}

async function releaseTableSettlementLock(tableId, session) {
  await Table.findByIdAndUpdate(tableId, { $set: { activeSettlementId: null } }).session(
    session || null
  );
}

async function acquireParkourSettlementLock(raceMongoId, settlementId, session) {
  const q = ParkourRace.findOneAndUpdate(
    { _id: raceMongoId, activeSettlementId: null },
    { $set: { activeSettlementId: settlementId, settlementStatus: "pending" } },
    { new: true }
  );
  const updated = await (session ? q.session(session) : q);
  if (updated) return true;

  const race = await ParkourRace.findById(raceMongoId).session(session || null);
  if (!race?.activeSettlementId) return false;
  const existing = await GameSettlement.findOne({
    settlementId: race.activeSettlementId,
    settlementStatus: "completed",
  }).session(session || null);
  if (existing) {
    await ParkourRace.findByIdAndUpdate(raceMongoId, {
      $set: { activeSettlementId: null },
    }).session(session || null);
    return acquireParkourSettlementLock(raceMongoId, settlementId, session);
  }
  return false;
}

async function releaseParkourSettlementLock(raceMongoId, session) {
  await ParkourRace.findByIdAndUpdate(raceMongoId, {
    $set: { activeSettlementId: null },
  }).session(session || null);
}

async function releaseSettlementLock(tableId, gameType, session) {
  if (gameType === "parkour") return releaseParkourSettlementLock(tableId, session);
  return releaseTableSettlementLock(tableId, session);
}

function participantsFromParkourGame(players) {
  return (players || []).map((p) => ({
    userId: p.userId,
    seatIndex: p.seatIndex,
    buyIn: toSafeInt(p.buyIn, 0),
    isBot: false,
  }));
}

async function applySettlementLedger({ session, tableId, settlementId, plan }) {
  const isParkour = plan.gameType === "parkour";
  const table = isParkour ? null : await Table.findById(tableId).session(session || null);
  if (!isParkour && !table) throw new Error("TABLE_NOT_FOUND");

  for (const p of plan.participants) {
    if (p.isBot || !p.userId) {
      // Vacated human whose seat a bot played out: forfeit their locked buy-in.
      // forfeitTableSeatLock caps at the table-scoped lock, so recovery replays
      // are safe (second run finds 0 attributable and forfeits nothing).
      if (p.isBot && p.vacatedUserId && toSafeInt(p.buyIn, 0) > 0 && !isParkour) {
        await forfeitTableSeatLock({
          session,
          userId: p.vacatedUserId,
          tableId,
          seatChips: toSafeInt(p.buyIn, 0),
          meta: {
            reason: "settlement_vacated_seat_forfeit",
            settlementId,
            seatIndex: p.seatIndex,
            gameType: plan.gameType,
          },
        });
      }
      continue;
    }

    if (await participantSettlementAlreadyApplied(settlementId, p.userId, session)) {
      logger.info("game_settlement_participant_skip", {
        settlementId,
        userId: String(p.userId),
      });
      continue;
    }

    await recordGameBuyinLedger({
      session,
      userId: p.userId,
      amount: p.buyIn,
      tableId,
      settlementId,
      meta: { seatIndex: p.seatIndex, gameType: plan.gameType },
    });

    if (p.netDelta !== 0 || p.rakeShare > 0) {
      await applyGameSettlementDelta({
        session,
        userId: p.userId,
        delta: p.netDelta,
        rakeAmount: p.rakeShare,
        tableId,
        settlementId,
        meta: {
          seatIndex: p.seatIndex,
          buyIn: p.buyIn,
          payout: p.payout,
          isWinner: p.isWinner,
        },
      });
    }

    if (isParkour) {
      await setTableLockAmount({
        session,
        userId: p.userId,
        tableId,
        amount: p.payout,
      });
      if (p.payout > 0) {
        await releaseTableSeatToBalance({
          session,
          userId: p.userId,
          tableId,
          seatChips: p.payout,
          handId: settlementId,
          meta: { reason: "parkour_settlement_cashout", seatIndex: p.seatIndex },
        });
        await setTableLockAmount({
          session,
          userId: p.userId,
          tableId,
          amount: 0,
        });
      }
    } else {
      const seat = table.seats[p.seatIndex];
      if (seat && String(seat.user) === String(p.userId)) {
        seat.chips = p.payout;
        await setTableLockAmount({
          session,
          userId: p.userId,
          tableId,
          amount: p.payout,
        });
        if (p.payout > 0) {
          await releaseTableSeatToBalance({
            session,
            userId: p.userId,
            tableId,
            seatChips: p.payout,
            handId: settlementId,
            meta: { reason: "game_settlement_cashout", seatIndex: p.seatIndex },
          });
          seat.chips = 0;
        }
      }
    }

    await recordSettlementLedger({
      session,
      userId: p.userId,
      amount: p.payout,
      tableId,
      settlementId,
      meta: {
        seatIndex: p.seatIndex,
        buyIn: p.buyIn,
        netDelta: p.netDelta,
        rakeShare: p.rakeShare,
        isWinner: p.isWinner,
      },
    });
  }

  const humanNetDelta = plan.participants.reduce(
    (sum, p) => sum + (!p.isBot ? toSafeInt(p.netDelta, 0) : 0),
    0
  );
  if (humanNetDelta !== 0) {
    await applyHouseSettlementDelta({
      session,
      delta: -humanNetDelta,
      tableId,
      settlementId,
      meta: {
        gameType: plan.gameType,
        totalRake: toSafeInt(plan.totalRake, 0),
        totalHumanBuyIn: toSafeInt(plan.totalHumanBuyIn, 0),
        totalBotBuyIn: toSafeInt(plan.totalBotBuyIn, 0),
      },
    });
  }

  if (table) await table.save(session ? { session } : undefined);
}

/**
 * Settle a finished game. Idempotent — duplicate calls return existing completed settlement.
 */
async function settleGameOnFinish({
  gameType,
  tableId,
  sessionId,
  gameResult,
  gamePlayers,
  rakePercent,
}) {
  if (!tableId || !gameType) {
    throw new Error("SETTLEMENT_MISSING_PARAMS");
  }

  const table = await Table.findById(tableId);
  if (!table) throw new Error("TABLE_NOT_FOUND");
  await assertHouseWalletReady({ createIfMissing: process.env.NODE_ENV !== "production" });

  const participants = participantsFromTableAndGame(table, gamePlayers);
  const humanCount = participants.filter((p) => !p.isBot && p.userId).length;
  if (humanCount === 0) {
    logger.info("game_settlement_skipped_no_humans", { tableId: String(tableId), gameType });
    return { skipped: true, reason: "no_human_players" };
  }

  const rakePct = rakePercent != null ? rakePercent : getRakePercent(gameType);
  const plan = buildSettlementPlan({
    gameType,
    gameResult,
    participants,
    rakePercent: rakePct,
  });
  plan.gameType = gameType;

  const reconciliation = validateReconciliation(plan);
  if (!reconciliation.balanced) {
    throw new Error(`RECONCILIATION_FAILED:delta=${reconciliation.delta}`);
  }

  const settlementId = crypto.randomUUID();
  const idempotencyKey = buildIdempotencyKey({ tableId, gameType, sessionId, gameResult });

  const existing = await GameSettlement.findOne({ idempotencyKey });
  if (existing) {
    if (existing.settlementStatus === "completed") {
      return { duplicate: true, settlement: existing };
    }
    if (existing.settlementStatus === "pending") {
      return recoverPendingSettlement(existing.settlementId);
    }
  }

  let settlementDoc;
  let lockHeld = false;
  try {
    lockHeld = await acquireTableSettlementLock(tableId, settlementId);
    if (!lockHeld) {
      const pending = await GameSettlement.findOne({ tableId, settlementStatus: "pending" });
      if (pending) {
        return recoverPendingSettlement(pending.settlementId);
      }
      throw new Error("SETTLEMENT_TABLE_LOCK_BUSY");
    }

    settlementDoc = await GameSettlement.create({
      settlementId,
      idempotencyKey,
      gameType,
      tableId,
      sessionId: sessionId || null,
      settlementStatus: "pending",
      rakePercent: plan.rakePercent,
      totalBuyIn: plan.totalBuyIn,
      totalHumanBuyIn: plan.totalHumanBuyIn,
      totalBotBuyIn: plan.totalBotBuyIn,
      totalRake: plan.totalRake,
      totalPayout: plan.totalPayout,
      totalHumanPayout: plan.totalHumanPayout,
      totalBotPayout: plan.totalBotPayout,
      houseNetDelta: plan.houseNetDelta,
      participants: plan.participants,
      winners: plan.winners,
      reconciliation,
      gameResult,
    });
  } catch (err) {
    if (lockHeld) await releaseTableSettlementLock(tableId).catch(() => {});
    if (err && err.code === 11000) {
      const dup = await GameSettlement.findOne({ idempotencyKey });
      if (dup?.settlementStatus === "completed") return { duplicate: true, settlement: dup };
      if (dup) return recoverPendingSettlement(dup.settlementId);
    }
    throw err;
  }

  try {
    await withMongoTransaction(async (session) => {
      await applySettlementLedger({ session, tableId, settlementId, plan });
      await releaseSettlementLock(tableId, gameType, session);
    });

    settlementDoc.settlementStatus = "completed";
    settlementDoc.settledAt = new Date();
    await settlementDoc.save();

    logger.info("game_settlement_completed", {
      settlementId,
      tableId: String(tableId),
      gameType,
      totalBuyIn: plan.totalBuyIn,
      totalRake: plan.totalRake,
      totalPayout: plan.totalPayout,
    });

    return { success: true, settlement: settlementDoc, plan, reconciliation };
  } catch (err) {
    settlementDoc.settlementStatus = "failed";
    settlementDoc.errorMessage = err?.message || "unknown";
    await settlementDoc.save();
    await releaseSettlementLock(tableId, gameType).catch(() => {});
    logger.error("game_settlement_failed", {
      settlementId,
      tableId: String(tableId),
      reason: err?.message,
    });
    throw err;
  }
}

/** Retry wallet ops for a pending/failed settlement (server restart recovery). */
async function recoverPendingSettlement(settlementId) {
  const doc = await GameSettlement.findOne({ settlementId });
  if (!doc) throw new Error("SETTLEMENT_NOT_FOUND");
  if (doc.settlementStatus === "completed") {
    return { duplicate: true, settlement: doc };
  }

  const plan = {
    gameType: doc.gameType,
    totalBuyIn: doc.totalBuyIn,
    totalHumanBuyIn: doc.totalHumanBuyIn,
    totalBotBuyIn: doc.totalBotBuyIn,
    totalRake: doc.totalRake,
    totalPayout: doc.totalPayout,
    totalHumanPayout: doc.totalHumanPayout,
    totalBotPayout: doc.totalBotPayout,
    houseNetDelta: doc.houseNetDelta,
    participants: doc.participants,
    winners: doc.winners,
    rakePercent: doc.rakePercent,
  };

  const reconciliation = validateReconciliation(plan);
  if (!reconciliation.balanced) {
    // Release lock before throwing so the table is not permanently blocked.
    await releaseSettlementLock(doc.tableId, doc.gameType).catch((e) =>
      logger.error("settlement_recovery_lock_release_failed", {
        settlementId,
        reason: e?.message,
      })
    );
    throw new Error(`RECONCILIATION_FAILED:delta=${reconciliation.delta}`);
  }

  try {
    await withMongoTransaction(async (session) => {
      await applySettlementLedger({ session, tableId: doc.tableId, settlementId: doc.settlementId, plan });
      await releaseSettlementLock(doc.tableId, doc.gameType, session);
    });
  } catch (err) {
    // Guarantee lock is released even if the transaction throws.
    await releaseSettlementLock(doc.tableId, doc.gameType).catch((e) =>
      logger.error("settlement_recovery_lock_release_failed", {
        settlementId,
        reason: e?.message,
      })
    );
    doc.settlementStatus = "failed";
    doc.errorMessage = err?.message || "recovery_transaction_failed";
    await doc.save().catch(() => {});
    logger.error("settlement_recovery_failed", { settlementId, reason: err?.message });
    throw err;
  }

  doc.settlementStatus = "completed";
  doc.settledAt = new Date();
  doc.errorMessage = undefined;
  await doc.save();

  logger.info("settlement_recovered", { settlementId, tableId: String(doc.tableId), gameType: doc.gameType });
  return { recovered: true, settlement: doc };
}

/**
 * Settle a finished parkour race. Uses race Mongo _id as tableId for wallet locks.
 */
async function settleParkourRace({ raceMongoId, sessionId, gameResult, gamePlayers, rakePercent }) {
  if (!raceMongoId) throw new Error("SETTLEMENT_MISSING_PARAMS");

  const race = await ParkourRace.findById(raceMongoId);
  if (!race) throw new Error("RACE_NOT_FOUND");
  await assertHouseWalletReady({ createIfMissing: process.env.NODE_ENV !== "production" });

  const participants = participantsFromParkourGame(gamePlayers);
  const humanCount = participants.filter((p) => p.userId).length;
  if (humanCount === 0) {
    logger.info("parkour_settlement_skipped_no_humans", { raceMongoId: String(raceMongoId) });
    return { skipped: true, reason: "no_human_players" };
  }

  const gameType = "parkour";
  const rakePct = rakePercent != null ? rakePercent : getRakePercent(gameType);
  const plan = buildSettlementPlan({
    gameType,
    gameResult,
    participants,
    rakePercent: rakePct,
  });
  plan.gameType = gameType;

  const reconciliation = validateReconciliation(plan);
  if (!reconciliation.balanced) {
    throw new Error(`RECONCILIATION_FAILED:delta=${reconciliation.delta}`);
  }

  const settlementId = crypto.randomUUID();
  const idempotencyKey = buildIdempotencyKey({
    tableId: raceMongoId,
    gameType,
    sessionId,
    gameResult,
  });

  const existing = await GameSettlement.findOne({ idempotencyKey });
  if (existing) {
    if (existing.settlementStatus === "completed") {
      return { duplicate: true, settlement: existing };
    }
    if (existing.settlementStatus === "pending") {
      return recoverPendingSettlement(existing.settlementId);
    }
  }

  let settlementDoc;
  let lockHeld = false;
  try {
    lockHeld = await acquireParkourSettlementLock(raceMongoId, settlementId);
    if (!lockHeld) {
      const pending = await GameSettlement.findOne({
        tableId: raceMongoId,
        settlementStatus: "pending",
      });
      if (pending) return recoverPendingSettlement(pending.settlementId);
      throw new Error("SETTLEMENT_RACE_LOCK_BUSY");
    }

    settlementDoc = await GameSettlement.create({
      settlementId,
      idempotencyKey,
      gameType,
      tableId: raceMongoId,
      sessionId: sessionId || null,
      settlementStatus: "pending",
      rakePercent: plan.rakePercent,
      totalBuyIn: plan.totalBuyIn,
      totalHumanBuyIn: plan.totalHumanBuyIn,
      totalBotBuyIn: plan.totalBotBuyIn,
      totalRake: plan.totalRake,
      totalPayout: plan.totalPayout,
      totalHumanPayout: plan.totalHumanPayout,
      totalBotPayout: plan.totalBotPayout,
      houseNetDelta: plan.houseNetDelta,
      participants: plan.participants,
      winners: plan.winners,
      reconciliation,
      gameResult,
    });
  } catch (err) {
    if (lockHeld) await releaseParkourSettlementLock(raceMongoId).catch(() => {});
    if (err && err.code === 11000) {
      const dup = await GameSettlement.findOne({ idempotencyKey });
      if (dup?.settlementStatus === "completed") return { duplicate: true, settlement: dup };
      if (dup) return recoverPendingSettlement(dup.settlementId);
    }
    throw err;
  }

  try {
    await withMongoTransaction(async (session) => {
      await applySettlementLedger({ session, tableId: raceMongoId, settlementId, plan });
      await releaseParkourSettlementLock(raceMongoId, session);
    });

    settlementDoc.settlementStatus = "completed";
    settlementDoc.settledAt = new Date();
    await settlementDoc.save();

    await ParkourRace.findByIdAndUpdate(raceMongoId, {
      $set: { state: "settled", settlementStatus: "completed" },
    });

    logger.info("parkour_settlement_completed", {
      settlementId,
      raceMongoId: String(raceMongoId),
      totalBuyIn: plan.totalBuyIn,
      totalRake: plan.totalRake,
      totalPayout: plan.totalPayout,
    });

    return { success: true, settlement: settlementDoc, plan, reconciliation };
  } catch (err) {
    settlementDoc.settlementStatus = "failed";
    settlementDoc.errorMessage = err?.message || "unknown";
    await settlementDoc.save();
    await releaseParkourSettlementLock(raceMongoId).catch(() => {});
    await ParkourRace.findByIdAndUpdate(raceMongoId, {
      $set: { settlementStatus: "failed" },
    }).catch(() => {});
    logger.error("parkour_settlement_failed", {
      settlementId,
      raceMongoId: String(raceMongoId),
      reason: err?.message,
    });
    throw err;
  }
}

async function listGameSettlements(filters = {}) {
  const q = {};
  if (filters.gameType) q.gameType = filters.gameType;
  if (filters.tableId) q.tableId = filters.tableId;
  if (filters.playerId) q["participants.userId"] = filters.playerId;
  if (filters.settlementStatus) q.settlementStatus = filters.settlementStatus;

  if (filters.from || filters.to) {
    q.settledAt = {};
    if (filters.from) q.settledAt.$gte = new Date(filters.from);
    if (filters.to) q.settledAt.$lte = new Date(filters.to);
  }

  const page = Math.max(1, toSafeInt(filters.page, 1));
  const limit = Math.min(100, Math.max(1, toSafeInt(filters.limit, 20)));
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    GameSettlement.find(q).sort({ settledAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    GameSettlement.countDocuments(q),
  ]);

  return { items, total, page, limit };
}

async function adminListGameSettlements(req, res) {
  const { gameType, tableId, playerId, from, to, page, limit, settlementStatus } = req.query;
  const data = await listGameSettlements({
    gameType,
    tableId,
    playerId,
    from,
    to,
    page,
    limit,
    settlementStatus,
  });
  res.status(200).json({ status: "success", results: data.items.length, data });
}

module.exports = {
  getRakePercent,
  resolveWinnerSeatIndices,
  buildSettlementPlan,
  validateReconciliation,
  buildIdempotencyKey,
  settleGameOnFinish,
  settleParkourRace,
  recoverPendingSettlement,
  listGameSettlements,
  adminListGameSettlements,
  isTableSettlementBlocked,
};
