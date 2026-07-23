/**
 * Game socket handlers - join_game, bid, play_card, leave_room, choose_trump
 */
const matchMaker = require("../../matchmaking/matchMaker");
const roomManager = require("../../rooms/roomManager");
const { registerParkourHandlers, resumeRestoredRaces } = require("./parkour.handlers");
const parkourRoomManager = require("../../games/parkour/parkourRoomManager");
const { recoverParkourSettlements, ensureDefaultTrack } = require("../../services/parkourService");
const {
  abandonTrixTableIfNoHumans,
} = require("../../services/trixRecoveryService");
const Table = require("../../models/tableModel");
const User = require("../../models/userModel");
const Wallet = require("../../models/walletModel");
const MiniGamePlay = require("../../models/miniGamePlayModel");
const { trackTrixWin } = require("../../services/taskService");
const { settleGameOnFinish } = require("../../services/gameSettlementService");
const { archiveCardGameMatch } = require("../../services/cardGameHistoryService");
const { markTrixTablePlaying } = require("../../services/tableService");
const { emitTablesUpdated } = require("../../utils/lobbyRealtime");
const {
  scheduleCardTableVacate,
  onCardTableRejoin,
} = require("../../services/cardTableVacateService");
const logger = require("../../utils/logger");
const tableChat = require("../../sockets/tableChat");
const ActionPipeline = require("../../engine/ActionPipeline");
const spectatorService = require("../../services/spectatorService");
const socketPresenceService = require("../../services/socketPresenceService");
const DiceEngine = require("../../games/dice/DiceEngine");
const kingArthRoundState = require("../../games/dice/kingArthRoundState");
const kingArthSeedRotation = require("../../games/dice/kingArthSeedRotation");
const { recordSpin, recordBigWin } = require("../../games/dice/kingArthRtp");
const { recordSpinAnalytics } = require("../../games/dice/kingArthAnalytics");

// King Arth (Zeus) uses the shared app-coin economy, same as the other
// mini-games (Poseidon/Golden Tree): min bet 10,000 coins.
const DICE_MIN_BET = 10000;
const DICE_MAX_BET = 40000000;
const BET_EPS = 1e-4;

function sanitizeVolatility(raw) {
  const s = String(raw || "medium").toLowerCase();
  if (s === "low" || s === "medium" || s === "high") return s;
  return "medium";
}

function sanitizeClientSeed(raw) {
  if (typeof raw !== "string") return null;
  const s = raw
    .slice(0, 64)
    .replace(/[^a-zA-Z0-9_-]/g, "");
  if (s.length < 8) return null;
  return s;
}

function seatUserId(seat) {
  if (!seat) return null;
  const raw = seat.user && seat.user._id ? seat.user._id : seat.user;
  if (!raw) return null;
  return String(raw);
}

const { getTokenFromHandshake } = require("../../utils/socketAuth");

/** Broadcast game_state to all in room (each gets their own view - no opponent cards) */
function broadcastGameState(nsp, roomId) {
  const room = roomManager.getRoom(roomId);
  if (!room?.gameInstance) return;
  const game = room.gameInstance;
  game.players.forEach((p) => {
    const sock = nsp.sockets.get(p.socketId);
    if (sock) {
      const state = game.getGameState(p.seatIndex);
      sock.emit("game_state", state);
    }
  });
}

function broadcastTrixTableState(nsp, mongoTableId) {
  const game = roomManager.getTrixGameForTable(mongoTableId);
  if (!game?.gameState) return;
  game.players.forEach((p) => {
    if (p.isBot || !p.socketId) return;
    const sock = nsp.sockets.get(p.socketId);
    if (!sock) return;
    sock.emit("game_state", game.getGameState(p.seatIndex));
  });
  // Push public state (no private hands) to spectators.
  if (spectatorService.getCount(mongoTableId) > 0) {
    const spectState = game.getGameState(-1);
    if (spectState) nsp.to(`spec:${mongoTableId}`).emit("game_state", spectState);
  }
}

function emitToTrixHumans(nsp, mongoTableId, event, payload) {
  const game = roomManager.getTrixGameForTable(mongoTableId);
  if (!game) return;
  game.players.forEach((p) => {
    if (p.isBot || !p.socketId) return;
    const sock = nsp.sockets.get(p.socketId);
    if (sock) sock.emit(event, payload);
  });
}

function broadcastTarneeb41TableState(nsp, mongoTableId) {
  const game = roomManager.getTarneeb41GameForTable(mongoTableId);
  if (!game) return;
  game.players.forEach((p) => {
    if (p.isBot || !p.socketId) return;
    const sock = nsp.sockets.get(p.socketId);
    if (!sock) return;
    sock.emit("game_state", game.getGameState(p.seatIndex));
  });
  // Push public state (no private hands) to spectators.
  if (spectatorService.getCount(mongoTableId) > 0) {
    const spectState = game.getGameState(-1);
    if (spectState) nsp.to(`spec:${mongoTableId}`).emit("game_state", spectState);
  }
}

function emitToTarneeb41Humans(nsp, mongoTableId, event, payload) {
  const game = roomManager.getTarneeb41GameForTable(mongoTableId);
  if (!game) return;
  game.players.forEach((p) => {
    if (p.isBot || !p.socketId) return;
    const sock = nsp.sockets.get(p.socketId);
    if (sock) sock.emit(event, payload);
  });
}

function wireTrixGame(nsp, tableId, game) {
  if (!game || game._trixWired) return;
  game._trixWired = true;
  const tid = String(tableId);
  game.setAfterMoveListener((result) => {
    void handleTrixAfterMove(nsp, { type: "trix", tableId: tid, game }, result);
  });
  game.setStateChangedListener(() => {
    broadcastTrixTableState(nsp, tid);
  });
  game.setGameEventListener((event, payload) => {
    if (
      event === "turn_timer_started" ||
      event === "turn_timer_update" ||
      event === "turn_timer_expired"
    ) {
      emitToTrixHumans(nsp, tid, event, payload);
    } else if (event === "bot_chat" && payload) {
      // Forward a bot's chat/emoji to seated players + spectators (same event
      // humans use — no special client logic).
      nsp.to(`trix:${tid}`).emit("table_chat", payload);
      nsp.to(`spec:${tid}`).emit("table_chat", payload);
    }
  });
}

function getOrCreateTrixGameWired(nsp, tableId) {
  const game = roomManager.getOrCreateTrixGame(tableId);
  wireTrixGame(nsp, tableId, game);
  return game;
}

async function handleTrixAfterMove(nsp, ctx, result) {
  if (!ctx?.game || ctx.type !== "trix") return;
  const { tableId, game } = ctx;

  if (result?.duplicate) {
    broadcastTrixTableState(nsp, tableId);
    return;
  }

  if (result?.gameStarted) {
    try {
      await markTrixTablePlaying(tableId);
    } catch (err) {
      logger.error("trix_mark_playing_failed", {
        tableId: String(tableId),
        reason: err?.message,
      });
    }
    emitTablesUpdated({ gameType: "trix", reason: "game_start", tableId: String(tableId) });
  }

  if (result?.roundEnded || game.state === "round_end") {
    const roundResult = game.getRoundResult ? game.getRoundResult() : null;
    if (roundResult) {
      emitToTrixHumans(nsp, tableId, "round_result", roundResult);
    }
  }

  if (game.isGameFinished && game.isGameFinished()) {
    if (!game._settlementTriggered) {
      game._settlementTriggered = true;
      roomManager.markTrixGameFinished(tableId);
      const gameResult = game.getGameResult ? game.getGameResult() : null;
      if (gameResult) {
        emitToTrixHumans(nsp, tableId, "game_finished", gameResult);
        if (Array.isArray(game.players) && gameResult.winnerIndex != null) {
          const winner = game.players[gameResult.winnerIndex];
          if (winner && !winner.isBot && winner.userId) {
            trackTrixWin(winner.userId, { tableId: ctx.tableId });
          }
        }
        emitTablesUpdated({ gameType: "trix", reason: "game_end", tableId: String(tableId) });
        await runGameSettlement(nsp, ctx, gameResult);
      }
    }
  }

  broadcastTrixTableState(nsp, tableId);
}

function wireTarneeb41Game(nsp, tableId, game) {
  if (!game || game._tarneeb41Wired) return;
  game._tarneeb41Wired = true;
  const tid = String(tableId);
  game.setCountdownStartGate(async () => {
    const { validateTarneeb41StartEligibility } = require("../../services/tableService");
    const result = await validateTarneeb41StartEligibility(tid, game);
    return result.ok;
  });
  game.setGameEventListener((event, payload) => {
    if (
      event === "turn_timer_started" ||
      event === "turn_timer_update" ||
      event === "turn_timer_expired" ||
      event === "game_start_countdown" ||
      event === "game_start_countdown_cancelled"
    ) {
      emitToTarneeb41Humans(nsp, tid, event, payload);
    } else if (event === "bot_chat" && payload) {
      // Forward a bot's chat/emoji to seated players + spectators.
      nsp.to(`tarneeb41:${tid}`).emit("table_chat", payload);
      nsp.to(`spec:${tid}`).emit("table_chat", payload);
    }
  });
  game.setAfterMoveListener((result) => {
    void handleTarneeb41AfterMove(nsp, { type: "tarneeb41", tableId: tid, game }, result);
  });
}

async function handleTarneeb41AfterMove(nsp, ctx, result) {
  if (!ctx?.game || ctx.type !== "tarneeb41") return;
  const { tableId, game } = ctx;

  if (result?.duplicate) {
    broadcastTarneeb41TableState(nsp, tableId);
    return;
  }

  if (result?.gameStarted) {
    emitTablesUpdated({ gameType: "tarneeb41", reason: "game_start", tableId: String(tableId) });
  }

  if (result?.trickComplete || result?.trickResolved) {
    broadcastTarneeb41TableState(nsp, tableId);
  }

  if (result?.redeal) {
    emitToTarneeb41Humans(nsp, tableId, "redeal_required", {
      reason: result.reason || "sum_below_min",
      minSum: result.minSum || 11,
      declaredBids: [...game.declaredBids],
    });
  }

  if (result?.roundEnded || game.state === "round_end") {
    const roundResult = game.getRoundResult ? game.getRoundResult() : null;
    if (roundResult) {
      emitToTarneeb41Humans(nsp, tableId, "round_result", roundResult);
    }
  }

  if (game.isGameFinished && game.isGameFinished()) {
    if (!game._settlementTriggered) {
      game._settlementTriggered = true;
      roomManager.markTarneeb41GameFinished(tableId);
      const gameResult = game.getGameResult ? game.getGameResult() : null;
      if (gameResult) {
        emitToTarneeb41Humans(nsp, tableId, "game_finished", gameResult);
        emitTablesUpdated({ gameType: "tarneeb41", reason: "game_end", tableId: String(tableId) });
        await runGameSettlement(nsp, ctx, gameResult);
      }
    }
  }

  broadcastTarneeb41TableState(nsp, tableId);
}

function getOrCreateTarneeb41GameWired(nsp, tableId) {
  const game = roomManager.getOrCreateTarneeb41Game(tableId);
  wireTarneeb41Game(nsp, tableId, game);
  return game;
}

async function maybeAbandonTrixTable(nsp, tableId) {
  if (!tableId) return null;
  try {
    const result = await abandonTrixTableIfNoHumans(tableId);
    if (result?.abandoned) {
      logger.info("trix_table_abandoned", {
        tableId: String(tableId),
        refunded: result.refunded,
      });
    } else {
      roomManager.tryClearTrixGameIfReady(tableId);
    }
    return result;
  } catch (err) {
    logger.error("trix_abandon_failed", {
      tableId: String(tableId),
      reason: err?.message || "unknown",
    });
    return null;
  }
}

function publishCardGameActivityForHumans(ctx, sourceId) {
  if (!ctx?.game?.players) return;
  try {
    const { publish } = require("../../domain/events/domainEventBus");
    const Events = require("../../domain/events/eventTypes");
    for (const p of ctx.game.players) {
      if (p.isBot || !p.userId) continue;
      publish(Events.PLAYER_COMPLETED_GAME, {
        userId: String(p.userId),
        gameType: ctx.type,
        sourceId: sourceId || String(ctx.tableId),
      });
    }
  } catch (_) {}
}

async function runGameSettlement(nsp, ctx, gameResult) {
  if (!ctx?.tableId || !ctx?.type || !gameResult) return null;
  if (ctx.type !== "trix" && ctx.type !== "tarneeb41") return null;
  try {
    const outcome = await settleGameOnFinish({
      gameType: ctx.type,
      tableId: ctx.tableId,
      sessionId: ctx.game?.sessionId,
      gameResult,
      gamePlayers: ctx.game?.players,
    });
    if (outcome?.settlement) {
      const payload = {
        settlementId: outcome.settlement.settlementId,
        totalPayout: outcome.settlement.totalPayout,
        totalRake: outcome.settlement.totalRake,
        reconciliation: outcome.settlement.reconciliation,
      };
      void archiveCardGameMatch({
        gameType: ctx.type,
        tableId: ctx.tableId,
        tableNumber: ctx.game?.tableNumber,
        sessionId: ctx.game?.sessionId,
        gameResult,
        gamePlayers: ctx.game?.players,
        settlement: outcome.settlement,
        game: ctx.game,
      }).catch((err) => {
        logger.warn("card_game_archive_failed", {
          tableId: String(ctx.tableId),
          gameType: ctx.type,
          reason: err?.message,
        });
      });
      if (ctx.type === "trix") {
        emitToTrixHumans(nsp, ctx.tableId, "settlement_complete", payload);
        if (ctx.game) {
          ctx.game._lastSettlementPayload = payload;
          ctx.game._lastSettlementFailure = null;
        }
        roomManager.markTrixSettlementComplete(ctx.tableId);
        roomManager.tryClearTrixGameIfReady(ctx.tableId);
        roomManager.evictExpiredTrixGames();
        emitTablesUpdated({
          gameType: "trix",
          reason: "settlement_complete",
          tableId: String(ctx.tableId),
        });
      } else {
        emitToTarneeb41Humans(nsp, ctx.tableId, "settlement_complete", payload);
        if (ctx.game) {
          ctx.game._lastSettlementPayload = payload;
          ctx.game._lastSettlementFailure = null;
        }
        roomManager.markTarneeb41SettlementComplete(ctx.tableId);
        roomManager.tryClearTarneeb41GameIfReady(ctx.tableId);
        roomManager.evictExpiredTarneeb41Games();
        emitTablesUpdated({
          gameType: "tarneeb41",
          reason: "settlement_complete",
          tableId: String(ctx.tableId),
        });
      }
      publishCardGameActivityForHumans(
        ctx,
        outcome?.settlement?.settlementId || String(ctx.tableId)
      );
    }
    return outcome;
  } catch (err) {
    logger.error("game_settlement_hook_failed", {
      tableId: String(ctx.tableId),
      gameType: ctx.type,
      reason: err?.message || "unknown",
    });
    if (ctx.type === "trix") {
      emitToTrixHumans(nsp, ctx.tableId, "settlement_failed", {
        reason: err?.message || "settlement_failed",
      });
      if (ctx.game) {
        ctx.game._lastSettlementFailure = {
          reason: err?.message || "settlement_failed",
        };
      }
    } else if (ctx.type === "tarneeb41") {
      emitToTarneeb41Humans(nsp, ctx.tableId, "settlement_failed", {
        reason: err?.message || "settlement_failed",
      });
      if (ctx.game) {
        ctx.game._lastSettlementFailure = {
          reason: err?.message || "settlement_failed",
        };
      }
    }
    return null;
  }
}

/** @returns {{ type:'room', room: object, game: object } | { type:'trix', tableId: string, game: object } | { type:'tarneeb41', tableId: string, game: object } | null} */
function resolveGameContext(userId, roomIdFromPayload) {
  const room = roomManager.getRoomByUser(userId);
  if (room && String(room.roomId) === String(roomIdFromPayload)) {
    return { type: "room", room, game: room.gameInstance };
  }
  const trix = roomManager.getTrixContextForUser(userId);
  if (trix && String(trix.tableId) === String(roomIdFromPayload)) {
    return { type: "trix", tableId: trix.tableId, game: trix.game };
  }
  const t41 = roomManager.getTarneeb41ContextForUser(userId);
  if (t41 && String(t41.tableId) === String(roomIdFromPayload)) {
    return { type: "tarneeb41", tableId: t41.tableId, game: t41.game };
  }
  return null;
}

/** Register game handlers on namespace */
function registerGameHandlers(nsp, jwtVerify) {
  registerParkourHandlers(nsp);
  roomManager.startTarneeb41TtlSweep();
  roomManager.startTrixTtlSweep();

  void (async () => {
    try {
      await ensureDefaultTrack();
      const restored = await parkourRoomManager.restoreActiveRaces();
      if (restored > 0) {
        logger.info("parkour_races_restored", { count: restored });
        resumeRestoredRaces(nsp);
      }
      const settlements = await recoverParkourSettlements();
      if (settlements > 0) logger.info("parkour_settlements_recovered", { count: settlements });
      // Card-game settlement recovery runs in runBootSanitizer() before sockets accept connections.
    } catch (err) {
      logger.error("parkour_startup_recovery_failed", { reason: err?.message });
    }
  })();

  nsp.on("connection", (socket) => {
    const userId = socket.user?.id || socket.userId;
    if (!userId) {
      socket.emit("invalid_move", { reason: "authentication_required" });
      return;
    }

    // Per-socket sliding-window rate limiter: 60 events / 10 s
    const _rl = { count: 0, windowStart: Date.now() };
    const GAME_NS_MAX = 60;
    const GAME_NS_WINDOW_MS = 10_000;
    socket.use(([_event, ..._args], next) => {
      const now = Date.now();
      if (now - _rl.windowStart > GAME_NS_WINDOW_MS) {
        _rl.count = 1;
        _rl.windowStart = now;
      } else {
        _rl.count++;
      }
      if (_rl.count > GAME_NS_MAX) {
        const cb = _args.find((a) => typeof a === "function");
        if (cb) cb({ ok: false, code: "rate_limited" });
        logger.warn("game_ns_rate_limited", { userId, event: _event });
        return;
      }
      next();
    });

    // join_trix_table — must be seated via REST on a trix Mongo table
    socket.on("join_trix_table", async (payload) => {
      try {
        const { tableId } = payload || {};
        if (!tableId) {
          socket.emit("invalid_move", { reason: "tableId required" });
          return;
        }
        const table = await Table.findById(tableId).populate({
          path: "seats.user",
          select: "name country profileImg",
        });
        if (!table) {
          socket.emit("invalid_move", { reason: "table_not_found" });
          return;
        }
        if (table.gameType !== "trix") {
          socket.emit("invalid_move", { reason: "not_trix_table" });
          return;
        }
        const userIdStr = String(userId);
        const seated = table.seats.some((s) => seatUserId(s) === userIdStr);
        if (!seated) {
          socket.emit("invalid_move", { reason: "not_seated_at_table" });
          return;
        }
        matchMaker.dequeue("trix", userId);
        onCardTableRejoin({ gameType: "trix", tableId: table._id, userId });
        roomManager.setTrixUserSocket(String(userId), socket.id);
        roomManager.setUserTrixTable(String(userId), String(table._id));
        await socketPresenceService.registerSocket(table._id, userId);
        const game = getOrCreateTrixGameWired(nsp, table._id);

        const liveHuman = game.players.find(
          (p) => !p.isBot && p.userId && String(p.userId) === userIdStr
        );
        if (
          liveHuman &&
          liveHuman.reconnectDeadline &&
          liveHuman.reconnectDeadline < Date.now()
        ) {
          const { finalizeCardTableVacate: finalizeVacate } = require("../../services/cardTableVacateService");
          await finalizeVacate({
            gameType: "trix",
            tableId: table._id,
            userId,
            nsp,
          });
          socket.emit("invalid_move", { reason: "reconnect_expired" });
          return;
        }

        await game.syncLobbyFromTable(table, (uid) => roomManager.getTrixUserSocket(String(uid)));
        await game.applyCosmeticsToPlayers();
        if (!game.gameState) {
          game.startGame();
        }
        let seatIndex = game.getPlayerIndex(userId);
        if (seatIndex < 0) {
          const mongoSeatIdx = table.seats.findIndex(
            (s) => seatUserId(s) === userIdStr
          );
          if (mongoSeatIdx >= 0) {
            const seat = table.seats[mongoSeatIdx];
            let nm = `لاعب ${mongoSeatIdx + 1}`;
            if (seat.user && typeof seat.user === "object" && seat.user.name) {
              nm = String(seat.user.name);
            }
            if (
              await game.restoreHumanAtSeat(
                mongoSeatIdx,
                userId,
                socket.id,
                nm
              )
            ) {
              seatIndex = mongoSeatIdx;
              await game.applyCosmeticsToPlayers();
            }
          }
        }
        if (seatIndex < 0) {
          await game.syncLobbyFromTable(table, (uid) => roomManager.getTrixUserSocket(String(uid)));
          await game.applyCosmeticsToPlayers();
          seatIndex = game.getPlayerIndex(userId);
        }
        if (seatIndex < 0) {
          socket.emit("invalid_move", { reason: "join_trix_failed" });
          return;
        }
        socket.join(`trix:${tableId}`);
        const state = game.getGameState(seatIndex);
        socket.emit("room_joined", {
          waiting: false,
          roomId: String(tableId),
          seatIndex,
          gameState: state,
        });
        if (game.state === "game_end") {
          const gameResult = game.getGameResult ? game.getGameResult() : null;
          if (gameResult) socket.emit("game_finished", gameResult);
          if (game._lastSettlementPayload) {
            socket.emit("settlement_complete", game._lastSettlementPayload);
          } else if (game._lastSettlementFailure) {
            socket.emit("settlement_failed", game._lastSettlementFailure);
          }
        } else if (game.state === "round_end") {
          const roundResult = game.getRoundResult ? game.getRoundResult() : null;
          if (roundResult) socket.emit("round_result", roundResult);
        }
        broadcastTrixTableState(nsp, String(table._id));
      } catch (err) {
        socket.emit("invalid_move", { reason: "join_trix_failed" });
      }
    });

    // join_tarneeb41_table — Syrian 41, Mongo table + bots
    socket.on("join_tarneeb41_table", async (payload) => {
      try {
        const { tableId } = payload || {};
        if (!tableId) {
          socket.emit("invalid_move", { reason: "tableId required" });
          return;
        }
        const table = await Table.findById(tableId).populate({
          path: "seats.user",
          select: "name country profileImg",
        });
        if (!table) {
          socket.emit("invalid_move", { reason: "table_not_found" });
          return;
        }
        if (table.gameType !== "tarneeb41") {
          socket.emit("invalid_move", { reason: "not_tarneeb41_table" });
          return;
        }
        const userIdStr = String(userId);
        const seated = table.seats.some((s) => seatUserId(s) === userIdStr);
        if (!seated) {
          socket.emit("invalid_move", { reason: "not_seated_at_table" });
          return;
        }
        matchMaker.dequeue("tarneeb41", userId);
        onCardTableRejoin({ gameType: "tarneeb41", tableId: table._id, userId });
        roomManager.setTarneeb41UserSocket(String(userId), socket.id);
        roomManager.setUserTarneeb41Table(String(userId), String(table._id));
        await socketPresenceService.registerSocket(table._id, userId);
        let game = getOrCreateTarneeb41GameWired(nsp, table._id);
        await game.syncLobbyFromTable(table, (uid) => roomManager.getTarneeb41UserSocket(String(uid)));
        await game.applyCosmeticsToPlayers();
        let seatIndex = game.getPlayerIndex(userId);
        if (seatIndex < 0) {
          const mongoSeatIdx = table.seats.findIndex(
            (s) => seatUserId(s) === userIdStr
          );
          if (mongoSeatIdx >= 0) {
            const seat = table.seats[mongoSeatIdx];
            let nm = `لاعب ${mongoSeatIdx + 1}`;
            if (seat.user && typeof seat.user === "object" && seat.user.name) {
              nm = String(seat.user.name);
            }
            if (
              await game.restoreHumanAtSeat(
                mongoSeatIdx,
                userId,
                socket.id,
                nm
              )
            ) {
              seatIndex = mongoSeatIdx;
              roomManager.setUserTarneeb41Table(String(userId), String(table._id));
              await game.applyCosmeticsToPlayers();
            }
          }
        }
        if (seatIndex < 0) {
          if (!game.needsInitialDeal()) {
            socket.emit("invalid_move", { reason: "join_tarneeb41_failed" });
            return;
          }
          // Discard the stale in-memory game and rebuild from Mongo — but
          // destroy() it first (not a raw Map delete) so its TimerManager
          // entries (bot/turn/trick timers) are cleared. The replacement
          // reuses the same roomId; leftover timers from an undestroyed
          // instance would keep firing under that shared namespace.
          if (typeof game.destroy === "function") game.destroy();
          roomManager.tarneeb41GamesByTableId.delete(String(table._id));
          game = getOrCreateTarneeb41GameWired(nsp, table._id);
          await game.syncLobbyFromTable(table, (uid) => roomManager.getTarneeb41UserSocket(String(uid)));
          await game.applyCosmeticsToPlayers();
          seatIndex = game.getPlayerIndex(userId);
        }
        if (seatIndex < 0) {
          socket.emit("invalid_move", { reason: "join_tarneeb41_failed" });
          return;
        }
        if (game.isReadyForCountdown() && !game.isCountdownActive()) {
          game.startGameCountdown();
        }
        socket.join(`tarneeb41:${tableId}`);
        const state = game.getGameState(seatIndex);
        socket.emit("room_joined", {
          waiting: false,
          roomId: String(tableId),
          seatIndex,
          gameState: state,
        });
        if (game.state === "game_end") {
          const gameResult = game.getGameResult ? game.getGameResult() : null;
          if (gameResult) socket.emit("game_finished", gameResult);
          if (game._lastSettlementPayload) {
            socket.emit("settlement_complete", game._lastSettlementPayload);
          } else if (game._lastSettlementFailure) {
            socket.emit("settlement_failed", game._lastSettlementFailure);
          }
        } else if (game.state === "round_end") {
          const roundResult = game.getRoundResult ? game.getRoundResult() : null;
          if (roundResult) socket.emit("round_result", roundResult);
        }
        broadcastTarneeb41TableState(nsp, String(table._id));
      } catch (err) {
        socket.emit("invalid_move", { reason: "join_tarneeb41_failed" });
      }
    });

    // join_game - add to matchmaking queue
    socket.on("join_game", async (payload) => {
      const { gameType = "tarneeb" } = payload || {};
      let result = matchMaker.enqueue(gameType, userId, socket.id);
      if (result && typeof result.then === "function") result = await result;
      if (result.error) {
        socket.emit("invalid_move", { reason: result.error });
        return;
      }
      if (result.waiting) {
        socket.emit("room_joined", {
          waiting: true,
          queueSize: result.queueSize,
          required: result.required,
        });
        return;
      }
      if (result.roomCreated && result.gameType === "parkour" && result.raceId) {
        const { raceId, players } = result;
        players.forEach((p) => {
          const sock = nsp.sockets.get(p.socketId);
          if (sock) {
            sock.join(`parkour:${raceId}`);
            parkourRoomManager.bindUser(p.userId, raceId, p.socketId);
            const room = parkourRoomManager.getRoom(raceId);
            if (room) {
              sock.emit("room_joined", {
                raceId,
                seatIndex: p.seatIndex,
                gameType: "parkour",
                roomState: room.game.getPublicState(p.userId),
              });
            }
          }
        });
        return;
      }
      if (result.roomCreated) {
        const { roomId, players } = result;
        players.forEach((p) => {
          const sock = nsp.sockets.get(p.socketId);
          if (sock) {
            sock.join(`room:${roomId}`);
            const state = roomManager.getGameState(roomId, p.userId);
            sock.emit("room_joined", { roomId, seatIndex: p.seatIndex, gameState: state });
          }
        });
        broadcastGameState(nsp, roomId);
      }
    });

    // Dice / King Arth — seeded fairness, Redis/Memory state, volatility, near-miss
    socket.on("dice_spin", async (payload) => {
      const tableId = (payload && payload.tableId) || "king-arth";
      if (!(await kingArthRoundState.tryAcquireLock(userId, tableId))) {
        socket.emit("dice_result", { ok: false, code: "already_spinning" });
        return;
      }

      const clientSeed = sanitizeClientSeed(
        payload && typeof payload.clientSeed === "string" ? payload.clientSeed : ""
      );
      const nonceStr = payload && payload.nonce != null ? String(payload.nonce) : "";
      if (!clientSeed) {
        await kingArthRoundState.releaseLock(userId, tableId);
        socket.emit("dice_result", { ok: false, code: "invalid_client_seed" });
        return;
      }
      if (!(await kingArthRoundState.validateNonce(userId, tableId, nonceStr))) {
        await kingArthRoundState.releaseLock(userId, tableId);
        socket.emit("dice_result", { ok: false, code: "invalid_nonce" });
        return;
      }

      const rawBet = Number(payload && payload.bet);
      const doubleChance = !!(payload && payload.doubleChance);
      const volatility = sanitizeVolatility(payload && payload.volatility);
      if (Number.isNaN(rawBet) || !Number.isFinite(rawBet)) {
        await kingArthRoundState.releaseLock(userId, tableId);
        socket.emit("dice_result", { ok: false, code: "invalid_bet" });
        return;
      }

      const user = await User.findById(userId);
      if (!user) {
        await kingArthRoundState.releaseLock(userId, tableId);
        socket.emit("dice_result", { ok: false, code: "user_not_found" });
        return;
      }

      const fsBefore = await kingArthRoundState.getFreeSpinSession(userId, tableId);
      const isFreeSpin = !!(fsBefore && fsBefore.remaining > 0);

      let bet = rawBet;
      if (isFreeSpin) {
        if (
          Math.abs(rawBet - fsBefore.lockedBaseBet) > BET_EPS ||
          !!doubleChance !== !!fsBefore.lockedDoubleChance
        ) {
          await kingArthRoundState.releaseLock(userId, tableId);
          socket.emit("dice_result", { ok: false, code: "free_spin_bet_mismatch" });
          return;
        }
        bet = fsBefore.lockedBaseBet;
      } else if (bet < DICE_MIN_BET || bet > DICE_MAX_BET) {
        await kingArthRoundState.releaseLock(userId, tableId);
        socket.emit("dice_result", { ok: false, code: "invalid_bet" });
        return;
      }

      const stake =
        Math.round(bet * (doubleChance ? 1.25 : 1) * 100) / 100;

      const seedPack = await kingArthSeedRotation.getSeedForSpin(userId);
      const serverSeed = seedPack.seed;
      const serverSeedHash = seedPack.serverSeedHash;
      const seedGeneration = seedPack.generation;

      let wallet;
      try {
        wallet = await Wallet.findOne({ user: userId });
        if (!wallet) wallet = await Wallet.create({ user: userId });

        if (!isFreeSpin && !wallet.hasSufficientBalance(stake)) {
          await kingArthRoundState.releaseLock(userId, tableId);
          socket.emit("dice_result", { ok: false, code: "insufficient_balance" });
          return;
        }

        if (!isFreeSpin) {
          await wallet.addTransaction(
            "debit",
            stake,
            `Dice / King Arth bet (${tableId})`
          );
        }

        const outcome = DiceEngine.spin(bet, {
          doubleChance,
          serverSeed,
          clientSeed,
          nonce: nonceStr,
          isFreeSpin,
          freeSpinMultiplier: isFreeSpin
            ? Number(fsBefore.totalMultiplier || 0)
            : 0,
          volatility,
        });
        let payout = outcome.totalWin;
        let roundCapReached = outcome.capped;

        // Free spins: enforce the cumulative 4000× round-win cap across the
        // whole session before crediting anything.
        if (isFreeSpin) {
          const capResult = await kingArthRoundState.recordRoundWin(
            userId,
            tableId,
            payout
          );
          payout = capResult.payout;
          if (capResult.capReached) roundCapReached = true;
        }

        if (payout > 0) {
          await wallet.addTransaction(
            "credit",
            payout,
            `King Earth win (${tableId}) ${outcome.winType}`
          );
        }

        await kingArthSeedRotation.recordSpinCompleted(userId);
        await recordSpin(stake, payout);
        await recordBigWin(outcome.winType);
        await recordSpinAnalytics(userId, stake, payout, outcome.winType);

        let freeSpinsAwarded = 0;
        if (isFreeSpin) {
          await kingArthRoundState.setFreeSpinTotalMultiplier(
            userId,
            tableId,
            outcome.multipliers.freeSpinTotal
          );
          if (roundCapReached) {
            // 4000× reached — end the round now, forfeit remaining spins.
            await kingArthRoundState.deleteFreeSpinSession(userId, tableId);
          } else {
            // Retrigger: 3+ scatters during free spins add 5 more.
            if (outcome.scatterCount >= DiceEngine.RETRIGGER_MIN_SCATTER) {
              freeSpinsAwarded = DiceEngine.RETRIGGER_AWARD;
              await kingArthRoundState.addRetriggerSpins(
                userId,
                tableId,
                DiceEngine.RETRIGGER_AWARD
              );
            }
            await kingArthRoundState.decrementFreeSpin(userId, tableId);
          }
        } else if (outcome.scatterCount >= 4 && !roundCapReached) {
          // Base spin trigger: 4+ scatters award 15 free spins.
          freeSpinsAwarded = DiceEngine.FREE_SPINS_AWARD;
          await kingArthRoundState.awardFreeSpins(
            userId,
            tableId,
            outcome.scatterCount,
            bet,
            doubleChance,
            {
              roundCap: DiceEngine.MAX_WIN_MULTIPLIER * stake,
              initialWin: payout,
            }
          );
        }

        wallet = await Wallet.findOne({ user: userId });

        const { publishSpinCompleted } = require("../../domain/publishers/playerActivityPublishers");

        const play = await MiniGamePlay.create({
          user: userId,
          type: "king-arth",
          bet: isFreeSpin ? 0 : stake,
          payout,
          profit: Math.round((payout - (isFreeSpin ? 0 : stake)) * 100) / 100,
          result: JSON.stringify({
            nonce: nonceStr,
            clientSeed,
            serverSeedHash,
            seedGeneration,
            volatility: outcome.volatility,
            lineWins: outcome.lineWins,
            scatterCount: outcome.scatterCount,
            multipliers: outcome.multipliers,
            cascadeSteps: outcome.cascadeSteps,
            winType: outcome.winType,
            isFreeSpin,
            nearMiss: outcome.nearMiss,
          }),
        });

        const freeSpinsRemaining =
          await kingArthRoundState.peekFreeSpinRemaining(userId, tableId);

        publishSpinCompleted(userId, {
          sourceId: String(play._id),
          game: "king-arth",
        });

        const fairness = {
          serverSeedHash,
          seedGeneration,
          seedRotated: !!seedPack.rotated,
        };
        if (seedPack.revealed) {
          fairness.disclosedServerSeed = seedPack.revealed.serverSeed;
          fairness.disclosedGeneration = seedPack.revealed.generation;
          fairness.disclosedServerSeedHash = seedPack.revealed.serverSeedHash;
        }

        socket.emit("dice_result", {
          ok: true,
          tableId,
          grid: outcome.grid,
          initialGrid: outcome.initialGrid,
          finalGrid: outcome.finalGrid,
          baseBet: outcome.baseBet,
          stake: outcome.stake,
          doubleChance: outcome.doubleChance,
          isFreeSpin,
          volatility: outcome.volatility,
          nearMiss: outcome.nearMiss,
          almostBonus: outcome.almostBonus,
          totalWin: payout,
          capped: roundCapReached,
          maxWin: outcome.maxWin,
          winningCells: outcome.winningCells,
          lineWins: outcome.lineWins,
          scatterCount: outcome.scatterCount,
          winType: outcome.winType,
          cascadeSteps: outcome.cascadeSteps,
          multipliers: outcome.multipliers,
          freeSpinsRemaining,
          freeSpinsAwarded,
          balance: wallet.balance,
          playId: String(play._id),
          fairness,
          nonce: nonceStr,
        });
      } catch (_err) {
        socket.emit("dice_result", { ok: false, code: "server_error" });
      } finally {
        await kingArthRoundState.releaseLock(userId, tableId);
      }
    });

    // King Earth — buy free spins (100× the total bet; disabled while ante is on)
    socket.on("dice_buy_bonus", async (payload) => {
      const tableId = (payload && payload.tableId) || "king-arth";
      if (!(await kingArthRoundState.tryAcquireLock(userId, tableId))) {
        socket.emit("dice_buy_result", { ok: false, code: "already_spinning" });
        return;
      }
      try {
        const rawBet = Number(payload && payload.bet);
        const doubleChance = !!(payload && payload.doubleChance);
        if (Number.isNaN(rawBet) || !Number.isFinite(rawBet)) {
          socket.emit("dice_buy_result", { ok: false, code: "invalid_bet" });
          return;
        }
        // Ante (double chance) disables the buy feature.
        if (doubleChance) {
          socket.emit("dice_buy_result", { ok: false, code: "buy_disabled_ante" });
          return;
        }
        if (rawBet < DICE_MIN_BET || rawBet > DICE_MAX_BET) {
          socket.emit("dice_buy_result", { ok: false, code: "invalid_bet" });
          return;
        }

        const existing = await kingArthRoundState.getFreeSpinSession(userId, tableId);
        if (existing && existing.remaining > 0) {
          socket.emit("dice_buy_result", { ok: false, code: "free_spins_active" });
          return;
        }

        const bet = rawBet;
        const stake = Math.round(bet * 100) / 100;
        const cost = Math.round(bet * DiceEngine.BUY_COST_MULT * 100) / 100;

        const user = await User.findById(userId);
        if (!user) {
          socket.emit("dice_buy_result", { ok: false, code: "user_not_found" });
          return;
        }

        let wallet = await Wallet.findOne({ user: userId });
        if (!wallet) wallet = await Wallet.create({ user: userId });
        if (!wallet.hasSufficientBalance(cost)) {
          socket.emit("dice_buy_result", { ok: false, code: "insufficient_balance" });
          return;
        }

        await wallet.addTransaction(
          "debit",
          cost,
          `King Earth buy free spins (${tableId})`
        );

        await kingArthRoundState.startFreeSpinSession(userId, tableId, {
          lockedBaseBet: bet,
          lockedDoubleChance: false,
          spins: DiceEngine.FREE_SPINS_AWARD,
          roundCap: DiceEngine.MAX_WIN_MULTIPLIER * stake,
          initialWin: 0,
        });

        await recordSpin(cost, 0);

        wallet = await Wallet.findOne({ user: userId });

        const play = await MiniGamePlay.create({
          user: userId,
          type: "king-arth",
          bet: cost,
          payout: 0,
          profit: -cost,
          result: JSON.stringify({
            buyFreeSpins: true,
            betPerSpin: bet,
            cost,
            tableId,
          }),
        });

        const {
          publishSpinCompleted,
        } = require("../../domain/publishers/playerActivityPublishers");
        publishSpinCompleted(userId, {
          sourceId: String(play._id),
          game: "king-arth",
        });

        const freeSpinsRemaining =
          await kingArthRoundState.peekFreeSpinRemaining(userId, tableId);

        socket.emit("dice_buy_result", {
          ok: true,
          tableId,
          cost,
          betPerSpin: bet,
          freeSpinsRemaining,
          freeSpinsAwarded: DiceEngine.FREE_SPINS_AWARD,
          balance: wallet.balance,
          playId: String(play._id),
        });
      } catch (_err) {
        socket.emit("dice_buy_result", { ok: false, code: "server_error" });
      } finally {
        await kingArthRoundState.releaseLock(userId, tableId);
      }
    });

    // bid
    socket.on("bid", (payload) => {
      const { roomId, value } = payload || {};
      const room = roomManager.getRoomByUser(userId);
      if (!room || String(room.roomId) !== String(roomId)) {
        socket.emit("invalid_move", { reason: "not_in_room" });
        return;
      }
      const game = room.gameInstance;
      const guard = ActionPipeline.run({ userId, game, requireRunning: false });
      if (!guard.ok) {
        socket.emit("invalid_move", { reason: guard.reason, code: guard.code });
        return;
      }
      const result = game.applyMove(guard.playerIndex, "bid", { value });
      if (!result.success) {
        socket.emit("invalid_move", { reason: result.reason });
        return;
      }
      broadcastGameState(nsp, roomId);
    });

    // choose_trump (Tarneeb - declarer chooses trump after winning bid)
    socket.on("choose_trump", (payload) => {
      const { roomId, trump } = payload || {};
      const room = roomManager.getRoomByUser(userId);
      if (!room || String(room.roomId) !== String(roomId)) {
        socket.emit("invalid_move", { reason: "not_in_room" });
        return;
      }
      const game = room.gameInstance;
      if (!game || !game.chooseTrump) return;
      const guard = ActionPipeline.run({ userId, game, requireRunning: false });
      if (!guard.ok) {
        socket.emit("invalid_move", { reason: guard.reason, code: guard.code });
        return;
      }
      const ok = game.chooseTrump(guard.playerIndex, trump);
      if (!ok) {
        socket.emit("invalid_move", { reason: "invalid_trump" });
        return;
      }
      broadcastGameState(nsp, roomId);
    });

    // select_game (Trix - king selects game type)
    socket.on("select_game", (payload) => {
      const { roomId, gameType } = payload || {};
      const ctx = resolveGameContext(userId, roomId);
      if (!ctx?.game) {
        socket.emit("invalid_move", { reason: "not_in_room" });
        return;
      }
      const guard = ActionPipeline.run({ userId, game: ctx.game, requireRunning: false });
      if (!guard.ok) {
        socket.emit("invalid_move", { reason: guard.reason, code: guard.code });
        return;
      }
      const result = ctx.game.applyMove(guard.playerIndex, "select_game", {
        gameType,
        moveId: payload && payload.moveId,
      });
      if (!result.success) {
        socket.emit("invalid_move", { reason: result.reason });
        return;
      }
      if (ctx.type === "trix") {
        if (result.duplicate) broadcastTrixTableState(nsp, ctx.tableId);
      } else broadcastGameState(nsp, ctx.room.roomId);
    });

    // tarneeb41_declare — Syrian individual declares (2–13 or pass)
    socket.on("tarneeb41_declare", (payload) => {
      const { roomId, value } = payload || {};
      const ctx = resolveGameContext(userId, roomId);
      if (!ctx?.game || ctx.type !== "tarneeb41") {
        socket.emit("invalid_move", { reason: "not_in_room" });
        return;
      }
      const guard = ActionPipeline.run({ userId, game: ctx.game, requireRunning: false });
      if (!guard.ok) {
        socket.emit("invalid_move", { reason: guard.reason, code: guard.code });
        return;
      }
      const result = ctx.game.applyMove(guard.playerIndex, "tarneeb41_declare", {
        value,
        moveId: payload && payload.moveId,
      });
      if (!result.success) {
        socket.emit("invalid_move", { reason: result.reason });
        return;
      }
    });

    // play_card
    socket.on("play_card", (payload) => {
      const { roomId, card } = payload || {};
      const ctx = resolveGameContext(userId, roomId);
      if (!ctx?.game) {
        socket.emit("invalid_move", { reason: "not_in_room" });
        return;
      }
      const game = ctx.game;
      const guard = ActionPipeline.run({ userId, game, requireRunning: true });
      if (!guard.ok) {
        socket.emit("invalid_move", { reason: guard.reason, code: guard.code });
        return;
      }
      const result = game.applyMove(guard.playerIndex, "play_card", {
        card,
        moveId: payload && payload.moveId,
      });
      if (!result.success) {
        socket.emit("invalid_move", { reason: result.reason });
        return;
      }
      if (ctx.type === "tarneeb41") {
        return;
      }
      if (ctx.type === "trix") {
        if (result.duplicate) {
          broadcastTrixTableState(nsp, ctx.tableId);
        }
        return;
      }
      if (game.state === "round_end") {
        const roundResult = game.getRoundResult ? game.getRoundResult() : null;
        if (roundResult) {
          if (ctx.type === "trix") {
            emitToTrixHumans(nsp, ctx.tableId, "round_result", roundResult);
          } else nsp.to(`room:${roomId}`).emit("round_result", roundResult);
        }
      }
      if (game.isGameFinished()) {
        const gameResult = game.getGameResult ? game.getGameResult() : null;
        if (gameResult) {
          if (ctx.type === "trix") {
            emitToTrixHumans(nsp, ctx.tableId, "game_finished", gameResult);
            if (Array.isArray(game.players) && gameResult.winnerIndex != null) {
              const winner = game.players[gameResult.winnerIndex];
              if (winner && !winner.isBot && winner.userId) {
                trackTrixWin(winner.userId, { tableId: ctx.tableId });
            try {
              const { publish } = require("../../domain/events/domainEventBus");
              const Events = require("../../domain/events/eventTypes");
              publish(Events.PLAYER_COMPLETED_GAME, {
                userId: String(winner.userId),
                gameType: "trix",
              });
            } catch (_) {}
              }
            }
            void runGameSettlement(nsp, ctx, gameResult);
          } else nsp.to(`room:${roomId}`).emit("game_finished", gameResult);
        }
      }
      if (ctx.type === "trix") broadcastTrixTableState(nsp, ctx.tableId);
      else broadcastGameState(nsp, ctx.room.roomId);
    });

    // next_round - start next deal when state is round_end (client triggers when ready)
    socket.on("next_round", (payload) => {
      const { roomId } = payload || {};
      const ctx = resolveGameContext(userId, roomId);
      if (!ctx?.game) {
        socket.emit("invalid_move", { reason: "not_in_room", code: "ERR_NOT_SEATED" });
        return;
      }
      const guard = ActionPipeline.run({ userId, game: ctx.game, requireRunning: false });
      if (!guard.ok) {
        socket.emit("invalid_move", { reason: guard.reason, code: guard.code });
        return;
      }
      let ok = false;
      if (ctx.type === "tarneeb41" && typeof ctx.game.advanceNextRound === "function") {
        ok = ctx.game.advanceNextRound();
      } else if (ctx.type === "trix" && ctx.game.nextRound) {
        ok = ctx.game.nextRound();
      } else if (ctx.game.nextRound) {
        ok = ctx.game.nextRound();
      }
      if (ok && ctx.type !== "trix" && ctx.type !== "tarneeb41") {
        broadcastGameState(nsp, ctx.room.roomId);
      }
    });

    // fill_with_bots — client requests AI fill after waiting (no humans available)
    socket.on("fill_with_bots", async (payload) => {
      const { roomId } = payload || {};
      const t41 = roomManager.getTarneeb41TableIdForUser(userId);
      if (!t41 || (roomId && String(t41) !== String(roomId))) {
        socket.emit("invalid_move", { reason: "not_in_tarneeb41_room" });
        return;
      }
      const game = roomManager.getTarneeb41GameForTable(t41);
      if (!game) {
        socket.emit("invalid_move", { reason: "game_not_found" });
        return;
      }
      if (game.state !== "waiting") {
        broadcastTarneeb41TableState(nsp, t41);
        return;
      }
      await game.fillWithBots();
      broadcastTarneeb41TableState(nsp, t41);
    });

    // leave_room — 30s grace before bot replacement
    socket.on("leave_room", (payload) => {
      const { roomId } = payload || {};
      const t41 = roomManager.getTarneeb41TableIdForUser(userId);
      if (roomId && t41 && String(t41) === String(roomId)) {
        roomManager.deleteTarneeb41UserSocket(userId);
        socket.leave(`tarneeb41:${roomId}`);
        matchMaker.dequeue("tarneeb41", userId);
        scheduleCardTableVacate({
          gameType: "tarneeb41",
          tableId: t41,
          userId,
          nsp,
        });
        broadcastTarneeb41TableState(nsp, t41);
        return;
      }
      const trixId = roomManager.getTrixTableIdForUser(userId);
      if (trixId && (!roomId || String(trixId) === String(roomId))) {
        roomManager.deleteTrixUserSocket(userId);
        if (roomId) socket.leave(`trix:${roomId}`);
        matchMaker.dequeue("trix", userId);
        scheduleCardTableVacate({
          gameType: "trix",
          tableId: trixId,
          userId,
          nsp,
        });
        broadcastTrixTableState(nsp, trixId);
        return;
      }
      const r = roomManager.removeUserFromRoom(userId);
      if (r) {
        socket.leave(`room:${r.room.roomId}`);
        matchMaker.dequeue("tarneeb", userId);
        matchMaker.dequeue("trix", userId);
      }
    });

    // ── Spectator handlers ──────────────────────────────────────────────────
    socket.on("spectate_table", async ({ tableId, gameType } = {}) => {
      if (!tableId) return;
      const tid = String(tableId);
      try {
        const table = await Table.findById(tid).select("settings gameType tableKind");
        if (!table) return socket.emit("spectate_error", { reason: "table_not_found" });
        if (table.settings?.allowSpectators === false) {
          return socket.emit("spectate_error", { reason: "spectators_disabled" });
        }
        spectatorService.add(tid, userId, socket.id);
        socket.join(`spec:${tid}`);

        const gt = gameType || table.gameType;
        if (gt === "trix") {
          const game = roomManager.getTrixGameForTable(tid);
          if (game?.gameState) {
            socket.emit("game_state", game.getGameState(-1));
          }
        } else if (gt === "tarneeb41") {
          const game = roomManager.getTarneeb41GameForTable(tid);
          if (game) {
            socket.emit("game_state", game.getGameState(-1));
          }
        }
        socket.emit("spectate_joined", { tableId: tid, spectators: spectatorService.getCount(tid) });
      } catch (err) {
        logger.error("spectate_table_error", { userId, tableId: tid, reason: err?.message });
      }
    });

    socket.on("stop_spectate", ({ tableId } = {}) => {
      if (!tableId) return;
      const tid = String(tableId);
      spectatorService.remove(tid, userId);
      socket.leave(`spec:${tid}`);
    });

    // ── In-table chat (trix + tarneeb41 share the /game namespace) ───────────
    socket.on("table_chat", (payload, ack) => {
      try {
        const { tableId, body, emoji } = payload || {};
        if (!tableId) return;
        const tid = String(tableId);

        // Figure out which game room this seated socket belongs to.
        let room = null;
        let game = null;
        const gt = payload?.gameType;
        if ((gt === "trix" || !gt) && socket.rooms.has(`trix:${tid}`)) {
          room = `trix:${tid}`;
          game = roomManager.getTrixGameForTable(tid);
        } else if (
          (gt === "tarneeb41" || !gt) &&
          socket.rooms.has(`tarneeb41:${tid}`)
        ) {
          room = `tarneeb41:${tid}`;
          game = roomManager.getTarneeb41GameForTable(tid);
        }
        if (!room) return;

        const rate = tableChat.checkRate(userId);
        if (!rate.ok) {
          if (typeof ack === "function") {
            ack({ ok: false, reason: "rate_limited", retryAfterMs: rate.retryAfterMs });
          }
          return;
        }

        let name = payload?.name;
        const avatar = payload?.avatar;
        if (game && Array.isArray(game.players)) {
          const p = game.players.find(
            (x) => String(x.userId) === String(userId)
          );
          if (p && p.name) name = p.name;
        }

        const built = tableChat.buildChatMessage({
          userId,
          name,
          avatar,
          body,
          emoji,
        });
        if (!built.ok) {
          if (typeof ack === "function") ack(built);
          return;
        }
        // Broadcast to seated players and to any spectators of this table.
        nsp.to(room).emit("table_chat", built.message);
        nsp.to(`spec:${tid}`).emit("table_chat", built.message);
        if (typeof ack === "function") ack({ ok: true, id: built.message.id });
      } catch (e) {
        logger.error("table_chat_failed", {
          userId,
          reason: e?.message || "unknown",
        });
      }
    });

    socket.on("disconnect", async () => {
      // Clean up any spectator subscriptions on disconnect.
      // spectatorService stores userId → socketId; we use the socket.rooms to find spec: rooms.
      for (const room of socket.rooms) {
        if (room.startsWith("spec:")) {
          const tid = room.slice(5);
          spectatorService.remove(tid, userId);
        }
      }
      void kingArthRoundState.clearLocksForUser(userId);
      const t41 = roomManager.getTarneeb41TableIdForUser(userId);
      if (t41) {
        // Duplicate-tab guard: another live socket for this user may still be
        // joined to this table (another tab/device) — its connection already
        // owns the roomManager socketId mapping, so don't clear it or start a
        // vacate timer against a user who is still actually connected.
        const remaining = await socketPresenceService.releaseSocket(t41, userId);
        if (remaining > 0) return;
        roomManager.deleteTarneeb41UserSocket(userId);
        const game = roomManager.getTarneeb41GameForTable(t41);
        if (game) {
          const p = game.players.find((x) => String(x.userId) === String(userId));
          if (p) p.socketId = null;
          broadcastTarneeb41TableState(nsp, t41);
        }
        scheduleCardTableVacate({
          gameType: "tarneeb41",
          tableId: t41,
          userId,
          nsp,
        });
        return;
      }
      const trixId = roomManager.getTrixTableIdForUser(userId);
      if (trixId) {
        const remaining = await socketPresenceService.releaseSocket(trixId, userId);
        if (remaining > 0) return;
        roomManager.deleteTrixUserSocket(userId);
        const game = roomManager.getTrixGameForTable(trixId);
        if (game) {
          const p = game.players.find((x) => String(x.userId) === String(userId));
          if (p) p.socketId = null;
          broadcastTrixTableState(nsp, trixId);
        }
        scheduleCardTableVacate({
          gameType: "trix",
          tableId: trixId,
          userId,
          nsp,
        });
        return;
      }
      const r = roomManager.removeUserFromRoom(userId);
      if (r) {
        matchMaker.dequeue("tarneeb", userId);
        matchMaker.dequeue("trix", userId);
        if (r.room?.gameInstance) {
          broadcastGameState(nsp, r.room.roomId);
        }
      }
    });
  });
}

module.exports = {
  registerGameHandlers,
  getTokenFromHandshake,
  broadcastGameState,
  broadcastTrixTableState,
  broadcastTarneeb41TableState,
};
