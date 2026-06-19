const Table = require("../models/tableModel");
const logger = require("../utils/logger");
const { POKER_TIMINGS } = require("../utils/poker/timings");
const { withMongoTransaction, forfeitTableSeatLock } = require("./walletLedgerService");
const { statusAfterSeatChange } = require("./pokerTableAllocationService");
const { seatNextFromQueue } = require("./pokerWaitingQueueService");
const { removeSeatPresence } = require("./pokerCollusionGuard");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");

function getTableGameBridge() {
  return require("../sockets/tableGame");
}

function vacateUntilDate() {
  return new Date(Date.now() + POKER_TIMINGS.VACATE_WINDOW_MS);
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
    vacateWindowMs: POKER_TIMINGS.VACATE_WINDOW_MS,
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

    table.vacatingPlayers = (table.vacatingPlayers || []).filter((v) => String(v.user) !== uid);
    table.seats.push({
      user: entry.user,
      player: entry.player || undefined,
      chips,
      joinedAt: new Date(),
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
      await forfeitTableSeatLock({
        session,
        userId: uid,
        tableId: tid,
        seatChips,
        meta: { reason: "vacate_bot_takeover" },
      });
    }
    await table.save({ session });
    finalized = true;
  });

  if (!finalized) return { ok: false, reason: "not_vacating" };

  emitTablesUpdated({ gameType: "poker", reason: "vacate_bot", tableId: tid });
  logger.info("poker_vacate_bot_takeover", { tableId: tid, userId: uid, chips: seatChips });

  return { ok: true, chips: seatChips };
}

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

module.exports = {
  vacatePokerSeat,
  tryRestoreVacatedSeat,
  finalizeVacateWithBot,
  findUserVacatingTable,
  findActiveVacatingEntry,
  isVacateActive,
  VACATE_WINDOW_MS: POKER_TIMINGS.VACATE_WINDOW_MS,
};
