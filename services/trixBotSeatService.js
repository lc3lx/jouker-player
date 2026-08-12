/**
 * Trix bot-seat takeover — any player may claim a bot seat mid-game;
 * vacated players may restore within the grace window.
 * Mirrors tarneeb41BotSeatService.
 */
const Table = require("../models/tableModel");
const roomManager = require("../rooms/roomManager");
const logger = require("../utils/logger");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");
const {
  withMongoTransaction,
  transferToLocked,
  forfeitTableSeatLock,
} = require("./walletLedgerService");
const { VACATE_MS } = require("./cardTableVacateService");

const ACTIVE_STATES = new Set([
  "waiting",
  "selecting_game",
  "playing",
  "round_end",
]);

function vacateUntilDate() {
  return new Date(Date.now() + VACATE_MS);
}

function isVacateActive(entry) {
  if (!entry?.vacateUntil) return false;
  return new Date(entry.vacateUntil).getTime() > Date.now();
}

function findVacatingEntry(table, userId) {
  const uid = String(userId);
  const list = Array.isArray(table?.vacatingPlayers) ? table.vacatingPlayers : [];
  return list.find((v) => String(v.user) === uid && isVacateActive(v)) || null;
}

function listReplaceableBotSeats(game) {
  if (!game || !Array.isArray(game.players)) return [];
  if (typeof game.listReplaceableBotSeats === "function") {
    return game.listReplaceableBotSeats();
  }
  return game.players
    .filter((p) => p.isBot && typeof p.seatIndex === "number")
    .map((p) => ({
      seatIndex: p.seatIndex,
      vacatedFromUserId: p.vacatedFromUserId ? String(p.vacatedFromUserId) : null,
    }));
}

function getGame(tableId) {
  return roomManager.getTrixGameForTable(tableId);
}

/**
 * @returns {Promise<{ claimed: boolean, seatIndex?: number, reason?: string, midHandJoin?: boolean }>}
 */
async function tryClaimTrixBotSeat({
  tableId,
  userId,
  playerId,
  buyIn,
  seatIndex: preferredSeat,
  socketId = null,
  displayName = null,
  nsp = null,
}) {
  const tid = String(tableId);
  const uid = String(userId);
  const game = getGame(tid);
  if (!game) return { claimed: false, reason: "no_game" };
  if (!ACTIVE_STATES.has(game.state)) {
    return { claimed: false, reason: "game_not_active" };
  }

  const botSeats = listReplaceableBotSeats(game);
  if (botSeats.length === 0) return { claimed: false, reason: "no_bot_seat" };

  let seatIndex = preferredSeat;
  if (seatIndex != null) {
    if (!botSeats.some((b) => b.seatIndex === seatIndex)) {
      return { claimed: false, reason: "seat_not_bot" };
    }
  } else {
    const restoreSeat = botSeats.find((b) => b.vacatedFromUserId === uid);
    seatIndex = restoreSeat ? restoreSeat.seatIndex : botSeats[0].seatIndex;
  }

  const botPlayer = game.players.find((p) => p.seatIndex === seatIndex && p.isBot);
  if (!botPlayer) return { claimed: false, reason: "seat_not_bot" };

  const isRestore =
    botPlayer.vacatedFromUserId && String(botPlayer.vacatedFromUserId) === uid;

  let resolvedName = displayName || `لاعب ${seatIndex + 1}`;
  let claimed = false;

  try {
    await withMongoTransaction(async (session) => {
      const table = await Table.findById(tid).session(session);
      if (!table || table.gameType !== "trix") throw new Error("NOT_TRIX");

      const seatedIdx = table.seats.findIndex((s) => String(s.user) === uid);
      if (seatedIdx >= 0) {
        claimed = true;
        return;
      }

      const activeHumanIds = new Set(
        (game.players || [])
          .filter((p) => p && !p.isBot && p.userId)
          .map((p) => String(p.userId))
      );

      if (isRestore) {
        const vac = findVacatingEntry(table, uid);
        const chips = vac ? Number(vac.chips) || buyIn : buyIn;
        table.seats.push({
          user: userId,
          player: playerId,
          chips,
        });
        table.vacatingPlayers = (table.vacatingPlayers || []).filter(
          (v) => String(v.user) !== uid
        );
        await table.save({ session });
        claimed = true;
        return;
      }

      if (buyIn < table.minBuyIn || buyIn > table.maxBuyIn) {
        throw new Error("INVALID_BUYIN");
      }

      table.vacatingPlayers = (table.vacatingPlayers || []).filter((v) => {
        if (Number(v.seatIndex) !== seatIndex) return true;
        const vacUid = String(v.user);
        return activeHumanIds.has(vacUid);
      });

      await transferToLocked({
        session,
        userId,
        amount: buyIn,
        tableId: tid,
        meta: { reason: "trix_bot_seat_claim", seatIndex },
      });

      table.seats.push({ user: userId, player: playerId, chips: buyIn });

      if (table.seats.length >= table.capacity) {
        table.status = "playing";
      }
      await table.save({ session });
      claimed = true;
    });
  } catch (err) {
    logger.warn("trix_bot_seat_claim_failed", {
      tableId: tid,
      userId: uid,
      seatIndex,
      reason: err?.message,
    });
    return { claimed: false, reason: err?.message || "claim_failed" };
  }

  if (!claimed) return { claimed: false, reason: "claim_failed" };

  const table = await Table.findById(tid).populate({
    path: "seats.user",
    select: "name",
  });
  const seat = table?.seats?.find((s) => s.user && String(s.user._id || s.user) === uid);
  if (seat?.user && typeof seat.user === "object" && seat.user.name) {
    resolvedName = String(seat.user.name);
  }

  const ok = await game.replaceBotWithHuman(seatIndex, userId, socketId, resolvedName, {
    chips: buyIn,
    allowTakeover: !isRestore,
  });
  if (!ok) {
    return { claimed: false, reason: "engine_replace_failed" };
  }

  await game.applyCosmeticsToPlayers();

  roomManager.setUserTrixTable(uid, tid);
  if (socketId) roomManager.setTrixUserSocket(uid, socketId);

  if (typeof game.checkBotTurn === "function") game.checkBotTurn();

  emitTablesUpdated({
    gameType: "trix",
    reason: "bot_seat_claimed",
    tableId: tid,
  });

  logger.info("trix_bot_seat_claimed", {
    tableId: tid,
    userId: uid,
    seatIndex,
    restore: isRestore,
  });

  if (nsp) {
    try {
      const { broadcastTrixTableState } = require("../socket/handlers/game.handlers");
      broadcastTrixTableState(nsp, tid);
    } catch (_) {
      // ignore
    }
  }

  return {
    claimed: true,
    seatIndex,
    restore: isRestore,
    midHandJoin: !isRestore,
  };
}

async function recordVacatedBotSeat({
  tableId,
  userId,
  seatIndex,
  chips,
  playerId,
  skipVacatingGrace = false,
}) {
  const tid = String(tableId);
  const uid = String(userId);
  const seatChips = Number(chips) || 0;
  await withMongoTransaction(async (session) => {
    const table = await Table.findById(tid).session(session);
    if (!table || table.gameType !== "trix") return;

    table.vacatingPlayers = (table.vacatingPlayers || []).filter(
      (v) => String(v.user) !== uid
    );
    if (!skipVacatingGrace) {
      table.vacatingPlayers.push({
        user: userId,
        player: playerId || undefined,
        chips: seatChips,
        vacatedAt: new Date(),
        vacateUntil: vacateUntilDate(),
        seatIndex,
      });
    }
    if (seatChips > 0) {
      await forfeitTableSeatLock({
        session,
        userId,
        tableId: tid,
        seatChips,
        meta: { reason: "trix_vacate_bot_takeover", seatIndex },
      });
    }
    const seatIdx = table.seats.findIndex(
      (s) => s.user && String(s.user) === uid
    );
    if (seatIdx >= 0) {
      table.seats.splice(seatIdx, 1);
      if (table.seats.length < table.capacity) {
        table.status = table.status === "playing" ? table.status : "open";
      }
    }
    await table.save({ session });
  });
}

module.exports = {
  listReplaceableBotSeats,
  tryClaimTrixBotSeat,
  recordVacatedBotSeat,
  ACTIVE_STATES,
};
