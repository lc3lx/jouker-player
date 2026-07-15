/**
 * Tarneeb41 bot-seat takeover — any player may claim a bot seat mid-game;
 * vacated players may restore within the grace window.
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
const waitingQueueService = require("./waitingQueueService");
const { VACATE_MS } = require("./cardTableVacateService");

const ACTIVE_STATES = new Set([
  "bidding_syrian",
  "playing",
  "round_end",
  "countdown",
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
  return game.players
    .filter((p) => p.isBot && typeof p.seatIndex === "number")
    .map((p) => ({
      seatIndex: p.seatIndex,
      vacatedFromUserId: p.vacatedFromUserId ? String(p.vacatedFromUserId) : null,
    }));
}

function getGame(tableId) {
  return roomManager.getTarneeb41GameForTable(tableId);
}

/**
 * @returns {Promise<{ claimed: boolean, seatIndex?: number, reason?: string }>}
 */
async function tryClaimTarneeb41BotSeat({
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
      if (!table || table.gameType !== "tarneeb41") throw new Error("NOT_TARNEEB41");

      const seatedElsewhere = table.seats.findIndex((s) => String(s.user) === uid);
      if (seatedElsewhere >= 0 && seatedElsewhere !== seatIndex) {
        throw new Error("ALREADY_SEATED_OTHER_SEAT");
      }

      if (isRestore && seatedElsewhere === seatIndex) {
        claimed = true;
        return;
      }

      if (isRestore) {
        const vac = findVacatingEntry(table, uid);
        const chips = vac ? Number(vac.chips) || buyIn : buyIn;
        while (table.seats.length < seatIndex) {
          throw new Error("SEAT_INDEX_GAP");
        }
        if (table.seats.length === seatIndex) {
          table.seats.push({
            user: userId,
            player: playerId,
            chips,
          });
        } else {
          table.seats[seatIndex].user = userId;
          table.seats[seatIndex].player = playerId;
          table.seats[seatIndex].chips = chips;
        }
        table.vacatingPlayers = (table.vacatingPlayers || []).filter(
          (v) => String(v.user) !== uid
        );
        await table.save({ session });
        claimed = true;
        return;
      }

      const existingAtSeat =
        table.seats.length > seatIndex ? table.seats[seatIndex] : null;
      if (existingAtSeat && String(existingAtSeat.user) === uid) {
        claimed = true;
        return;
      }

      if (buyIn < table.minBuyIn || buyIn > table.maxBuyIn) {
        throw new Error("INVALID_BUYIN");
      }

      if (existingAtSeat) {
        const oldUid = existingAtSeat.user;
        const oldChips = Number(existingAtSeat.chips) || 0;
        if (oldChips > 0) {
          await forfeitTableSeatLock({
            session,
            userId: oldUid,
            tableId: tid,
            seatChips: oldChips,
            meta: { reason: "tarneeb41_bot_seat_takeover", seatIndex },
          });
        }
        table.vacatingPlayers = (table.vacatingPlayers || []).filter(
          (v) =>
            !(
              Number(v.seatIndex) === seatIndex &&
              String(v.user) === String(oldUid)
            )
        );
      }

      await transferToLocked({
        session,
        userId,
        amount: buyIn,
        tableId: tid,
        meta: { reason: "tarneeb41_bot_seat_claim", seatIndex },
      });

      while (table.seats.length < seatIndex) {
        throw new Error("SEAT_INDEX_GAP");
      }
      if (table.seats.length === seatIndex) {
        table.seats.push({ user: userId, player: playerId, chips: buyIn });
      } else {
        table.seats[seatIndex].user = userId;
        table.seats[seatIndex].player = playerId;
        table.seats[seatIndex].chips = buyIn;
      }

      if (table.seats.length >= table.capacity) {
        table.status = "playing";
      }
      await table.save({ session });
      claimed = true;
    });
  } catch (err) {
    logger.warn("tarneeb41_bot_seat_claim_failed", {
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
  const seat = table?.seats?.[seatIndex];
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

  roomManager.setUserTarneeb41Table(uid, tid);
  if (socketId) roomManager.setTarneeb41UserSocket(uid, socketId);

  if (typeof game.checkBotTurn === "function") game.checkBotTurn();

  emitTablesUpdated({
    gameType: "tarneeb41",
    reason: "bot_seat_claimed",
    tableId: tid,
  });

  logger.info("tarneeb41_bot_seat_claimed", {
    tableId: tid,
    userId: uid,
    seatIndex,
    restore: isRestore,
  });

  if (nsp) {
    try {
      const { broadcastTarneeb41TableState } = require("../socket/handlers/game.handlers");
      broadcastTarneeb41TableState(nsp, tid);
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

async function recordVacatedBotSeat({ tableId, userId, seatIndex, chips, playerId }) {
  const tid = String(tableId);
  const uid = String(userId);
  await withMongoTransaction(async (session) => {
    const table = await Table.findById(tid).session(session);
    if (!table || table.gameType !== "tarneeb41") return;

    table.vacatingPlayers = (table.vacatingPlayers || []).filter(
      (v) => String(v.user) !== uid
    );
    table.vacatingPlayers.push({
      user: userId,
      player: playerId || undefined,
      chips: Number(chips) || 0,
      vacatedAt: new Date(),
      vacateUntil: vacateUntilDate(),
      seatIndex,
    });
    await table.save({ session });
  });
}

async function notifyBotSeatAvailable(nsp, tableId, seatIndex) {
  const tid = String(tableId);
  try {
    const dequeued = await waitingQueueService.dequeueNext(tid, "tarneeb41");
    if (dequeued) {
      const sock = roomManager.getTarneeb41UserSocket(dequeued.userId);
      const payload = {
        tableId: tid,
        seatIndex,
        buyIn: dequeued.buyIn,
      };
      if (sock) {
        sock.emit("bot_seat_available", payload);
        sock.emit("queue_seat_available", payload);
      }
    }
  } catch (err) {
    logger.warn("tarneeb41_bot_seat_notify_failed", {
      tableId: tid,
      reason: err?.message,
    });
  }

  emitTablesUpdated({
    gameType: "tarneeb41",
    reason: "bot_seat_available",
    tableId: tid,
  });

  if (nsp) {
    try {
      nsp.to(`tarneeb41:${tid}`).emit("bot_seat_available", {
        tableId: tid,
        seatIndex,
      });
    } catch (_) {
      // ignore
    }
  }
}

/**
 * Restore vacated tarneeb41 player within grace (mongo vacatingPlayers + engine bot).
 */
async function tryRestoreVacatedTarneeb41Seat({ tableId, userId, socketId, displayName }) {
  const tid = String(tableId);
  const uid = String(userId);
  const game = getGame(tid);
  if (!game) return null;

  const table = await Table.findById(tid);
  if (!table) return null;
  const vac = findVacatingEntry(table, uid);
  if (!vac || vac.seatIndex == null) return null;

  const seatIndex = Number(vac.seatIndex);
  const bot = game.players.find((p) => p.seatIndex === seatIndex && p.isBot);
  if (!bot) return null;

  const result = await tryClaimTarneeb41BotSeat({
    tableId: tid,
    userId,
    playerId: vac.player,
    buyIn: Number(vac.chips) || table.minBuyIn,
    seatIndex,
    socketId,
    displayName,
  });

  if (!result.claimed) return null;
  return { restored: true, seatIndex, tableId: tid };
}

module.exports = {
  listReplaceableBotSeats,
  tryClaimTarneeb41BotSeat,
  recordVacatedBotSeat,
  notifyBotSeatAvailable,
  tryRestoreVacatedTarneeb41Seat,
};
