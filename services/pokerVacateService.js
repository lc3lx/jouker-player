const Table = require("../models/tableModel");
const logger = require("../utils/logger");
const { POKER_TIMINGS } = require("../utils/poker/timings");
const { withMongoTransaction, releaseTableSeatToBalance } = require("./walletLedgerService");
const { statusAfterSeatChange } = require("./pokerTableAllocationService");
const { seatNextFromQueue } = require("./pokerWaitingQueueService");
const { removeSeatPresence } = require("./pokerCollusionGuard");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");

function getTableGameBridge() {
  return require("../sockets/pokerTableGameBridge");
}

function vacateUntilDate() {
  const { getSettings } = require("./tableLifecycleSettingsService");
  return new Date(Date.now() + getSettings().pokerVacateWindowMs);
}

function isVacateActive(entry) {
  if (!entry?.vacateUntil) return false;
  return new Date(entry.vacateUntil).getTime() > Date.now();
}

function findActiveVacatingEntry(table, userId) {
  const uid = String(userId);
  const list = Array.isArray(table?.vacatingPlayers) ? table.vacatingPlayers : [];
  return list.find((v) => String(v.user) === uid && isVacateActive(v)) || null;
}

function hasPendingPermanentLeave(table, userId) {
  const uid = String(userId);
  return (table?.pendingPermanentLeaves || []).some((entry) => String(entry.user) === uid);
}

/** Persist a voluntary in-hand leave before folding the engine seat. */
async function markPendingPermanentLeave({ tableId, userId }) {
  const tid = String(tableId);
  const uid = String(userId);
  await withMongoTransaction(async (session) => {
    const table = await Table.findById(tid).session(session);
    if (!table || table.gameType !== "poker") throw new Error("NOT_POKER");
    const seated = table.seats.some((seat) => String(seat.user) === uid);
    const vacating = (table.vacatingPlayers || []).some((seat) => String(seat.user) === uid);
    if (!seated && !vacating) throw new Error("NOT_SEATED");
    if (!hasPendingPermanentLeave(table, uid)) {
      table.pendingPermanentLeaves.push({ user: userId, requestedAt: new Date() });
      await table.save({ session });
    }
  });
  return { marked: true };
}

async function clearPendingPermanentLeave({ tableId, userId }) {
  await Table.updateOne(
    { _id: tableId, gameType: "poker", "pendingPermanentLeaves.user": userId },
    { $pull: { pendingPermanentLeaves: { user: userId } } }
  );
}

async function findUserVacatingTable(userId, tier = null) {
  const filter = { gameType: "poker", "vacatingPlayers.user": userId };
  if (tier) filter.tier = tier;
  const table = await Table.findOne(filter).select(
    "_id tableNumber tier vacatingPlayers seats gameType"
  );
  if (!table) return null;
  const entry = findActiveVacatingEntry(table, userId);
  if (!entry) return null;
  return { table, entry };
}

/**
 * Move human from seats → vacatingPlayers; engine shows empty seat; 30s bot timer.
 */
async function vacatePokerSeat({
  tableId,
  userId,
  clientIp = null,
  deviceId = null,
  reason = "leave",
}) {
  const tid = String(tableId);
  const uid = String(userId);
  let chips = 0;
  let vacateUntil = null;

  try {
    await withMongoTransaction(async (session) => {
      const table = await Table.findById(tid).session(session);
      if (!table || table.gameType !== "poker") throw new Error("NOT_POKER");

      const existing = findActiveVacatingEntry(table, uid);
      if (existing) {
        chips = toSafeInt(existing.chips, 0);
        vacateUntil = existing.vacateUntil;
        return;
      }

      const idx = table.seats.findIndex((s) => String(s.user) === uid);
      if (idx === -1) throw new Error("NOT_SEATED");

      const seat = table.seats[idx];
      chips = toSafeInt(seat.chips, 0);
      const player = seat.player || null;
      const seatPosition = seat.seatPosition != null ? seat.seatPosition : undefined;
      table.seats.splice(idx, 1);

      if (!Array.isArray(table.vacatingPlayers)) table.vacatingPlayers = [];
      table.vacatingPlayers = table.vacatingPlayers.filter((v) => String(v.user) !== uid);
      vacateUntil = vacateUntilDate();
      table.vacatingPlayers.push({
        user: seat.user,
        player,
        chips,
        vacatedAt: new Date(),
        vacateUntil,
        seatPosition,
      });

      table.status = statusAfterSeatChange(table, table.seats.length);
      await table.save({ session });
      await seatNextFromQueue({ session, tableId: tid });
    });
  } catch (e) {
    if (e.message === "NOT_SEATED" || e.message === "NOT_POKER") {
      return { vacated: false, reason: e.message };
    }
    throw e;
  }

  if (!vacateUntil) {
    const row = await Table.findById(tid).select("vacatingPlayers");
    const entry = findActiveVacatingEntry(row, uid);
    if (!entry) return { vacated: false, reason: "NOT_SEATED" };
    chips = toSafeInt(entry.chips, 0);
    vacateUntil = entry.vacateUntil;
  }

  await removeSeatPresence({
    tableId: tid,
    userId: uid,
    ip: clientIp,
    deviceId: deviceId || null,
  });

  await getTableGameBridge().vacateLiveEngineSeat(tid, uid, { chips, vacateUntil });

  emitTablesUpdated({ gameType: "poker", reason: "vacate", tableId: tid });
  logger.info("poker_seat_vacated", { tableId: tid, userId: uid, chips, reason });

  return {
    vacated: true,
    chips,
    vacateUntil,
    vacateWindowMs: require("./tableLifecycleSettingsService").getSettings().pokerVacateWindowMs,
  };
}

/**
 * Return within vacate window — restore mongo seat + engine seat (not a fresh buy-in).
 */
async function tryRestoreVacatedSeat({ tableId, userId }) {
  const tid = String(tableId);
  const uid = String(userId);
  let restored = null;

  await withMongoTransaction(async (session) => {
    const table = await Table.findById(tid).session(session);
    if (!table || table.gameType !== "poker") return;

    const entry = findActiveVacatingEntry(table, uid);
    if (!entry) return;

    const chips = toSafeInt(entry.chips, 0);
    if (table.seats.length >= table.capacity) throw new Error("TABLE_FULL");

    // Restore the original chair when still free; otherwise take the next free one.
    const {
      nextFreeSeatPosition,
      POKER_OPPOSITE_DEALER_SEAT,
    } = require("./pokerTableAllocationService");
    const occupied = new Set(
      table.seats.filter((s) => s.seatPosition != null).map((s) => s.seatPosition)
    );
    let seatPosition = entry.seatPosition != null ? entry.seatPosition : null;
    if (seatPosition == null || occupied.has(seatPosition)) {
      seatPosition =
        nextFreeSeatPosition(table.seats, table.capacity) ?? POKER_OPPOSITE_DEALER_SEAT;
    }

    table.vacatingPlayers = (table.vacatingPlayers || []).filter((v) => String(v.user) !== uid);
    table.seats.push({
      user: entry.user,
      player: entry.player || undefined,
      chips,
      joinedAt: new Date(),
      seatPosition,
    });
    table.status = statusAfterSeatChange(table, table.seats.length);
    await table.save({ session });

    restored = { chips, vacateUntil: entry.vacateUntil };
  });

  if (!restored) return null;

  await getTableGameBridge().restoreLiveEngineSeat(tid, uid, restored);
  emitTablesUpdated({ gameType: "poker", reason: "vacate_restore", tableId: tid });
  logger.info("poker_seat_vacate_restored", { tableId: tid, userId: uid, chips: restored.chips });

  return {
    restored: true,
    tableId: tid,
    chips: restored.chips,
    reconnect: true,
    vacateRestore: true,
  };
}

/**
 * Vacate window expired — forfeit wallet lock; bot takes chips in engine.
 */
async function finalizeVacateWithBot({ tableId, userId, chips }) {
  const tid = String(tableId);
  const uid = String(userId);
  const seatChips = toSafeInt(chips, 0);

  let finalized = false;
  await withMongoTransaction(async (session) => {
    const table = await Table.findById(tid).session(session);
    if (!table || table.gameType !== "poker") return;

    const before = (table.vacatingPlayers || []).length;
    table.vacatingPlayers = (table.vacatingPlayers || []).filter((v) => String(v.user) !== uid);
    if (table.vacatingPlayers.length === before) return;

    if (seatChips > 0) {
      await releaseTableSeatToBalance({
        session,
        userId: uid,
        seatChips,
        tableId: tid,
        meta: { reason: "vacate_expired_cashout", tableNumber: table.tableNumber },
      });
    }
    await table.save({ session });
    finalized = true;
  });

  if (!finalized) return { ok: false, reason: "not_vacating" };

  await getTableGameBridge().syncLivePokerTableAfterLeave(tid);
  emitTablesUpdated({ gameType: "poker", reason: "vacate_cashout", tableId: tid });
  logger.info("poker_vacate_expired_cashout", { tableId: tid, userId: uid, chips: seatChips });

  return { ok: true, chips: seatChips };
}

/**
 * Permanent leave: cash out, clear vacate window, reset table if last human.
 */
async function permanentLeavePokerTable({
  tableId,
  userId,
  clientIp = null,
  deviceId = null,
}) {
  const tid = String(tableId);
  const uid = String(userId);
  let cashedOut = 0;
  let wasSeated = false;

  try {
    await withMongoTransaction(async (session) => {
      const table = await Table.findById(tid).session(session);
      if (!table || table.gameType !== "poker") throw new Error("NOT_POKER");
      // Seat balances are persisted at hand settlement, not on each action.
      // Returning one while a hand is live would race the pot settlement.
      if (table.status === "playing") throw new Error("HAND_IN_PROGRESS");
      // N-1: never cash out a seat while the engine is mid-settlement for this
      // table — the two writes to table.seats[].chips must not interleave.
      if (table.activeSettlementId) throw new Error("SETTLEMENT_IN_PROGRESS");

      const vacEntry = findActiveVacatingEntry(table, uid);
      if (vacEntry) {
        wasSeated = true;
        const chips = toSafeInt(vacEntry.chips, 0);
        table.vacatingPlayers = (table.vacatingPlayers || []).filter(
          (v) => String(v.user) !== uid
        );
        if (chips > 0) {
          await releaseTableSeatToBalance({
            session,
            userId: uid,
            seatChips: chips,
            tableId: tid,
            meta: { reason: "leave_table_cashout", tableNumber: table.tableNumber },
          });
          cashedOut += chips;
        }
      }

      const idx = table.seats.findIndex((s) => String(s.user) === uid);
      if (idx >= 0) {
        wasSeated = true;
        const chips = toSafeInt(table.seats[idx].chips, 0);
        table.seats.splice(idx, 1);
        if (chips > 0) {
          await releaseTableSeatToBalance({
            session,
            userId: uid,
            seatChips: chips,
            tableId: tid,
            meta: { reason: "leave_table_cashout", tableNumber: table.tableNumber },
          });
          cashedOut += chips;
        }
      }

      if (!wasSeated) throw new Error("NOT_SEATED");

      table.pendingPermanentLeaves = (table.pendingPermanentLeaves || []).filter(
        (entry) => String(entry.user) !== uid
      );
      table.status = statusAfterSeatChange(table, table.seats.length);
      await table.save({ session });
      await seatNextFromQueue({ session, tableId: tid });
    });
  } catch (e) {
    if (
      e.message === "NOT_SEATED" ||
      e.message === "NOT_POKER" ||
      e.message === "SETTLEMENT_IN_PROGRESS" ||
      e.message === "HAND_IN_PROGRESS"
    ) {
      return { left: false, reason: e.message };
    }
    throw e;
  }

  await removeSeatPresence({
    tableId: tid,
    userId: uid,
    ip: clientIp,
    deviceId: deviceId || null,
  });

  const afterLeave = await Table.findById(tid).select("seats gameType vacatingPlayers");
  const activeVacating = (afterLeave?.vacatingPlayers || []).filter((v) => isVacateActive(v));
  if (
    afterLeave &&
    afterLeave.seats.length === 0 &&
    activeVacating.length === 0
  ) {
    await require("./pokerTableGcService").resetPokerTableWhenEmpty(tid);
  } else {
    // Mongo was committed above and is the only source of truth for a
    // permanent leave.  Do not splice the live engine here: doing so can
    // shift current/dealer/blind indexes if a stale engine still considers a
    // hand active.  The owner performs a fresh, safe sync from Mongo instead.
    await getTableGameBridge().syncLivePokerTableAfterLeave(tid);
    require("./pokerTableGcService").markTableActivity(tid);
  }

  emitTablesUpdated({ gameType: "poker", reason: "leave", tableId: tid });
  logger.info("poker_permanent_leave", { tableId: tid, userId: uid, cashedOut });

  return { left: true, cashedOut };
}

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

/**
 * Deferred cash-out for a leave requested while the table was mid-settlement.
 *
 * The client has already navigated to the lobby (so the player is never stuck);
 * here we retry the SAFE `permanentLeavePokerTable` — which cashes out to
 * balance — until the settlement lock clears. We deliberately do NOT route
 * through `vacatePokerSeat` during settlement: that reads `table.seats[].chips`
 * while settlement is writing the pot and could capture the pre-pot amount
 * (chip race / lost winnings). Instead we simply wait settlement out (seconds)
 * and then cash out cleanly. If we give up, the existing disconnect/vacate
 * timer still covers the seat.
 */
const deferredLeaveSchedules = new Map();

function scheduleDeferredPermanentLeave({ tableId, userId, clientIp = null, deviceId = null }) {
  const tid = String(tableId);
  const uid = String(userId);
  const scheduleKey = `${tid}:${uid}`;
  if (deferredLeaveSchedules.has(scheduleKey)) return false;
  deferredLeaveSchedules.set(scheduleKey, true);
  const delayMs = 1000;
  const maxAttempts = 600; // up to ten minutes for a full active hand
  let attempt = 0;
  const arm = () => {
    const t = setTimeout(() => void tick(), delayMs);
    if (typeof t.unref === "function") t.unref();
  };
  const tick = async () => {
    attempt += 1;
    try {
      const res = await permanentLeavePokerTable({ tableId: tid, userId: uid, clientIp, deviceId });
      if (res.left) {
        logger.info("poker_deferred_leave_completed", {
          tableId: tid, userId: uid, attempt, cashedOut: res.cashedOut,
        });
        deferredLeaveSchedules.delete(scheduleKey);
        return;
      }
      if (res.reason === "NOT_SEATED") {
        // A concurrent successful leave/vacate won the race. Clear stale intent.
        await clearPendingPermanentLeave({ tableId: tid, userId: uid });
        deferredLeaveSchedules.delete(scheduleKey);
        return;
      }
      // SETTLEMENT_IN_PROGRESS → keep waiting.
    } catch (e) {
      logger.warn("poker_deferred_leave_error", {
        tableId: tid, userId: uid, attempt, reason: e?.message,
      });
    }
    if (attempt < maxAttempts) {
      arm();
    } else {
      deferredLeaveSchedules.delete(scheduleKey);
      logger.warn("poker_deferred_leave_gave_up", { tableId: tid, userId: uid });
    }
  };
  arm();
  return true;
}

/** Re-arm durable deferred leaves after boot and after a successful settlement. */
async function resumePendingPermanentLeaves({ tableId = null } = {}) {
  const filter = { gameType: "poker", "pendingPermanentLeaves.0": { $exists: true } };
  if (tableId != null) filter._id = tableId;
  const tables = await Table.find(filter).select("_id pendingPermanentLeaves").lean();
  for (const table of tables) {
    for (const entry of table.pendingPermanentLeaves || []) {
      if (entry?.user) scheduleDeferredPermanentLeave({ tableId: table._id, userId: entry.user });
    }
  }
  return { resumed: tables.length };
}

module.exports = {
  vacatePokerSeat,
  tryRestoreVacatedSeat,
  finalizeVacateWithBot,
  permanentLeavePokerTable,
  markPendingPermanentLeave,
  clearPendingPermanentLeave,
  scheduleDeferredPermanentLeave,
  resumePendingPermanentLeaves,
  findUserVacatingTable,
  findActiveVacatingEntry,
  isVacateActive,
  VACATE_WINDOW_MS: POKER_TIMINGS.VACATE_WINDOW_MS,
};
