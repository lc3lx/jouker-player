/**
 * Game socket handlers - join_game, bid, play_card, leave_room, choose_trump
 */
const matchMaker = require("../../matchmaking/matchMaker");
const roomManager = require("../../rooms/roomManager");
const Table = require("../../models/tableModel");
const User = require("../../models/userModel");
const Wallet = require("../../models/walletModel");
const MiniGamePlay = require("../../models/miniGamePlayModel");
const DiceEngine = require("../../games/dice/DiceEngine");
const kingArthRoundState = require("../../games/dice/kingArthRoundState");
const kingArthSeedRotation = require("../../games/dice/kingArthSeedRotation");
const { recordSpin, recordBigWin } = require("../../games/dice/kingArthRtp");
const { recordSpinAnalytics } = require("../../games/dice/kingArthAnalytics");

const DICE_MIN_BET = 0.2;
const DICE_MAX_BET = 200;
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

function getTokenFromHandshake(socket) {
  const auth = socket.handshake.auth || {};
  if (auth.token) return auth.token.replace(/^Bearer\s+/i, "");
  const header = socket.handshake.headers?.authorization;
  if (header?.startsWith("Bearer ")) return header.split(" ")[1];
  const query = socket.handshake.query || {};
  if (query.token) return String(query.token).replace(/^Bearer\s+/i, "");
  return null;
}

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
  nsp.on("connection", (socket) => {
    const userId = socket.user?.id || socket.userId;
    if (!userId) {
      socket.emit("invalid_move", { reason: "authentication_required" });
      return;
    }

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
        roomManager.setTrixUserSocket(String(userId), socket.id);
        roomManager.setUserTrixTable(String(userId), String(table._id));
        const game = roomManager.getOrCreateTrixGame(table._id);
        game.setStateChangedListener(() => {
          broadcastTrixTableState(nsp, String(table._id));
        });
        game.syncLobbyFromTable(table, (uid) => roomManager.getTrixUserSocket(String(uid)));
        if (!game.gameState) {
          game.startGame();
        }
        let seatIndex = game.getPlayerIndex(userId);
        if (seatIndex < 0) {
          // Recover from stale in-memory game roster that doesn't match current DB seats.
          if (game.botInterval) {
            clearInterval(game.botInterval);
            game.botInterval = null;
          }
          game.gameState = null;
          game.state = "waiting";
          game.syncLobbyFromTable(table, (uid) => roomManager.getTrixUserSocket(String(uid)));
          game.startGame();
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
        roomManager.setTarneeb41UserSocket(String(userId), socket.id);
        roomManager.setUserTarneeb41Table(String(userId), String(table._id));
        let game = roomManager.getOrCreateTarneeb41Game(table._id);
        game.syncLobbyFromTable(table, (uid) => roomManager.getTarneeb41UserSocket(String(uid)));
        let seatIndex = game.getPlayerIndex(userId);
        if (seatIndex < 0) {
          roomManager.tarneeb41GamesByTableId.delete(String(table._id));
          game = roomManager.getOrCreateTarneeb41Game(table._id);
          game.syncLobbyFromTable(table, (uid) => roomManager.getTarneeb41UserSocket(String(uid)));
          seatIndex = game.getPlayerIndex(userId);
        }
        if (game.hands[0].length === 0) {
          game.startGame();
          seatIndex = game.getPlayerIndex(userId);
        }
        if (seatIndex < 0) {
          socket.emit("invalid_move", { reason: "join_tarneeb41_failed" });
          return;
        }
        socket.join(`tarneeb41:${tableId}`);
        socket.emit("room_joined", {
          waiting: false,
          roomId: String(tableId),
          seatIndex,
          gameState: game.getGameState(seatIndex),
        });
        broadcastTarneeb41TableState(nsp, String(table._id));
      } catch (err) {
        socket.emit("invalid_move", { reason: "join_tarneeb41_failed" });
      }
    });

    // join_game - add to matchmaking queue
    socket.on("join_game", (payload) => {
      const { gameType = "tarneeb" } = payload || {};
      const result = matchMaker.enqueue(gameType, userId, socket.id);
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
          volatility,
        });
        let payout = outcome.totalWin;

        if (payout > 0) {
          await wallet.addTransaction(
            "credit",
            payout,
            `Dice / King Arth win (${tableId}) ${outcome.winType}`
          );
        }

        await kingArthSeedRotation.recordSpinCompleted(userId);
        await recordSpin(stake, payout);
        await recordBigWin(outcome.winType);
        await recordSpinAnalytics(userId, stake, payout, outcome.winType);

        if (isFreeSpin) {
          await kingArthRoundState.decrementFreeSpin(userId, tableId);
        }

        let freeSpinsAwarded = 0;
        if (outcome.scatterCount >= 3) {
          freeSpinsAwarded =
            outcome.scatterCount >= 6
              ? 20
              : outcome.scatterCount >= 5
                ? 16
                : outcome.scatterCount >= 4
                  ? 12
                  : 8;
          await kingArthRoundState.awardFreeSpins(
            userId,
            tableId,
            outcome.scatterCount,
            bet,
            doubleChance
          );
        }

        wallet = await Wallet.findOne({ user: userId });

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
            winType: outcome.winType,
            isFreeSpin,
            nearMiss: outcome.nearMiss,
          }),
        });

        const freeSpinsRemaining =
          await kingArthRoundState.peekFreeSpinRemaining(userId, tableId);

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
          baseBet: outcome.baseBet,
          stake: outcome.stake,
          doubleChance: outcome.doubleChance,
          isFreeSpin,
          volatility: outcome.volatility,
          nearMiss: outcome.nearMiss,
          almostBonus: outcome.almostBonus,
          totalWin: payout,
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

    // bid
    socket.on("bid", (payload) => {
      const { roomId, value } = payload || {};
      const room = roomManager.getRoomByUser(userId);
      if (!room || String(room.roomId) !== String(roomId)) {
        socket.emit("invalid_move", { reason: "not_in_room" });
        return;
      }
      const game = room.gameInstance;
      if (!game) return;
      const playerIndex = game.getPlayerIndex(userId);
      if (playerIndex < 0) return;
      const result = game.applyMove(playerIndex, "bid", { value });
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
      const playerIndex = game.getPlayerIndex(userId);
      if (playerIndex < 0) return;
      const ok = game.chooseTrump(playerIndex, trump);
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
      const playerIndex = ctx.game.getPlayerIndex(userId);
      if (playerIndex < 0) return;
      const result = ctx.game.applyMove(playerIndex, "select_game", { gameType });
      if (!result.success) {
        socket.emit("invalid_move", { reason: result.reason });
        return;
      }
      if (ctx.type === "trix") broadcastTrixTableState(nsp, ctx.tableId);
      else broadcastGameState(nsp, ctx.room.roomId);
    });

    // tarneeb41_declare — Syrian individual declares (2–13 or pass)
    socket.on("tarneeb41_declare", (payload) => {
      const { roomId, value } = payload || {};
      const ctx = resolveGameContext(userId, roomId);
      if (!ctx?.game || ctx.type !== "tarneeb41") {
        socket.emit("invalid_move", { reason: "not_in_room" });
        return;
      }
      const playerIndex = ctx.game.getPlayerIndex(userId);
      if (playerIndex < 0) return;
      const result = ctx.game.applyMove(playerIndex, "tarneeb41_declare", { value });
      if (!result.success) {
        socket.emit("invalid_move", { reason: result.reason });
        return;
      }
      broadcastTarneeb41TableState(nsp, ctx.tableId);
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
      const playerIndex = game.getPlayerIndex(userId);
      if (playerIndex < 0) return;
      const result = game.applyMove(playerIndex, "play_card", { card });
      if (!result.success) {
        socket.emit("invalid_move", { reason: result.reason });
        return;
      }
      if (game.state === "round_end") {
        const roundResult = game.getRoundResult ? game.getRoundResult() : null;
        if (roundResult) {
          if (ctx.type === "trix") emitToTrixHumans(nsp, ctx.tableId, "round_result", roundResult);
          else if (ctx.type === "tarneeb41")
            emitToTarneeb41Humans(nsp, ctx.tableId, "round_result", roundResult);
          else nsp.to(`room:${roomId}`).emit("round_result", roundResult);
        }
      }
      if (game.isGameFinished()) {
        const gameResult = game.getGameResult ? game.getGameResult() : null;
        if (gameResult) {
          if (ctx.type === "trix") emitToTrixHumans(nsp, ctx.tableId, "game_finished", gameResult);
          else if (ctx.type === "tarneeb41")
            emitToTarneeb41Humans(nsp, ctx.tableId, "game_finished", gameResult);
          else nsp.to(`room:${roomId}`).emit("game_finished", gameResult);
        }
      }
      if (ctx.type === "trix") broadcastTrixTableState(nsp, ctx.tableId);
      else if (ctx.type === "tarneeb41") broadcastTarneeb41TableState(nsp, ctx.tableId);
      else broadcastGameState(nsp, ctx.room.roomId);
    });

    // next_round - start next deal when state is round_end (client triggers when ready)
    socket.on("next_round", (payload) => {
      const { roomId } = payload || {};
      const ctx = resolveGameContext(userId, roomId);
      if (!ctx?.game) return;
      let ok = false;
      if (ctx.type === "tarneeb41" && typeof ctx.game.advanceNextRound === "function") {
        ok = ctx.game.advanceNextRound();
      } else if (ctx.type === "trix" && ctx.game.nextRound) {
        ok = ctx.game.nextRound();
      } else if (ctx.game.nextRound) {
        ok = ctx.game.nextRound();
      }
      if (ok) {
        if (ctx.type === "trix") broadcastTrixTableState(nsp, ctx.tableId);
        else if (ctx.type === "tarneeb41") broadcastTarneeb41TableState(nsp, ctx.tableId);
        else broadcastGameState(nsp, ctx.room.roomId);
      }
    });

    // leave_room
    socket.on("leave_room", (payload) => {
      const { roomId } = payload || {};
      const t41 = roomManager.getTarneeb41TableIdForUser(userId);
      if (roomId && t41 && String(t41) === String(roomId)) {
        roomManager.leaveTarneeb41TableSocket(userId);
        roomManager.deleteTarneeb41UserSocket(userId);
        socket.leave(`tarneeb41:${roomId}`);
        matchMaker.dequeue("tarneeb41", userId);
        broadcastTarneeb41TableState(nsp, t41);
        return;
      }
      const trixId = roomManager.getTrixTableIdForUser(userId);
      if (roomId && trixId && String(trixId) === String(roomId)) {
        roomManager.leaveTrixTableSocket(userId);
        roomManager.deleteTrixUserSocket(userId);
        socket.leave(`trix:${roomId}`);
        matchMaker.dequeue("trix", userId);
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

    socket.on("disconnect", () => {
      void kingArthRoundState.clearLocksForUser(userId);
      const t41 = roomManager.getTarneeb41TableIdForUser(userId);
      if (t41) {
        roomManager.deleteTarneeb41UserSocket(userId);
        const game = roomManager.getTarneeb41GameForTable(t41);
        if (game) {
          const p = game.players.find((x) => String(x.userId) === String(userId));
          if (p) p.socketId = null;
          broadcastTarneeb41TableState(nsp, t41);
        }
        return;
      }
      const trixId = roomManager.getTrixTableIdForUser(userId);
      if (trixId) {
        roomManager.deleteTrixUserSocket(userId);
        const game = roomManager.getTrixGameForTable(trixId);
        if (game) {
          const p = game.players.find((x) => String(x.userId) === String(userId));
          if (p) p.socketId = null;
          broadcastTrixTableState(nsp, trixId);
        }
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

module.exports = { registerGameHandlers, getTokenFromHandshake, broadcastGameState };
