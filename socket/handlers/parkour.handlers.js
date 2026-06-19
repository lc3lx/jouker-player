/**
 * Parkour socket handlers — multiplayer race events on /game namespace.
 */
const parkourRoomManager = require("../../games/parkour/parkourRoomManager");
const ParkourGame = require("../../games/parkour/ParkourGame");
const { joinRace, runParkourSettlement } = require("../../services/parkourService");
const logger = require("../../utils/logger");

const TICK_MS = parseInt(process.env.PARKOUR_TICK_MS || "2000", 10);

function parkourRoomName(raceId) {
  return `parkour:${raceId}`;
}

function broadcastRoomState(nsp, room, forUserId = null) {
  const game = room.game;
  const payload = game.getPublicState(forUserId);
  nsp.to(parkourRoomName(game.raceId)).emit("room_state", payload);
}

function emitToPlayer(nsp, socketId, event, payload) {
  if (!socketId) return;
  const sock = nsp.sockets.get(socketId);
  if (sock) sock.emit(event, payload);
}

function emitToRaceHumans(nsp, room, event, payload) {
  for (const p of room.game.players) {
    if (p.socketId) emitToPlayer(nsp, p.socketId, event, payload);
  }
}

function scheduleRaceTick(nsp, room) {
  room.schedule(async () => {
    const still = parkourRoomManager.getRoom(room.game.raceId);
    if (!still || still !== room) return;

    const game = room.game;
    if (game.state === "countdown") {
      const tick = game.tickCountdown();
      if (tick?.phase === "starting") {
        await room.persist();
        emitToRaceHumans(nsp, room, "countdown_started", { remaining: 0, phase: "starting" });
        room.schedule(async () => {
          const start = game.startRace();
          if (start.success) {
            await room.persist();
            emitToRaceHumans(nsp, room, "race_started", {
              raceStartedAt: game.raceStartedAt,
              sessionId: game.sessionId,
            });
            broadcastRoomState(nsp, room);
          }
          scheduleRaceTick(nsp, room);
        }, 500);
        return;
      }
      emitToRaceHumans(nsp, room, "countdown_started", tick);
    }

    if (game.state === "playing") {
      const forfeited = game.checkDisconnectForfeits();
      for (const uid of forfeited) {
        emitToRaceHumans(nsp, room, "player_progress", {
          userId: uid,
          status: "forfeited",
        });
      }

      const timeout = game.checkRaceTimeout();
      if (timeout) {
        await finishRaceFlow(nsp, room, "race_timeout");
        return;
      }

      if (game.isRaceComplete()) {
        await finishRaceFlow(nsp, room, "all_finished");
        return;
      }
    }

    if (!["settled", "settlement_pending"].includes(game.state)) {
      scheduleRaceTick(nsp, room);
    }
  }, TICK_MS);
}

function startCountdownFlow(nsp, room) {
  const cd = room.game.startCountdownIfReady();
  if (!cd) return;

  room.persist().then(() => {
    emitToRaceHumans(nsp, room, "countdown_started", {
      countdownSec: cd.countdownSec,
      startedAt: cd.startedAt,
      remaining: cd.countdownSec,
    });
    broadcastRoomState(nsp, room);
    scheduleRaceTick(nsp, room);
  });
}

async function finishRaceFlow(nsp, room, reason) {
  const game = room.game;
  if (game.state === "finished" || game.state === "settlement_pending" || game.state === "settled") {
    return;
  }

  game.completeRace();
  await room.persist({ raceEndedAt: new Date() });

  emitToRaceHumans(nsp, room, "race_finished", {
    raceId: game.raceId,
    reason,
    finishers: game.getGameResult().finishers,
  });
  broadcastRoomState(nsp, room);

  try {
    const outcome = await runParkourSettlement(room);
    emitToRaceHumans(nsp, room, "settlement_complete", {
      raceId: game.raceId,
      settlementId: outcome?.settlement?.settlementId,
      duplicate: !!outcome?.duplicate,
      winners: outcome?.plan?.winners || outcome?.settlement?.winners,
    });
  } catch (err) {
    logger.error("parkour_settlement_emit_failed", { raceId: game.raceId, reason: err?.message });
    emitToRaceHumans(nsp, room, "settlement_complete", {
      raceId: game.raceId,
      error: err?.message || "settlement_failed",
    });
  }

  room.clearTimers();
  setTimeout(() => parkourRoomManager.removeRoom(game.raceId), 60000);
}

function registerParkourHandlers(nsp) {
  nsp.on("connection", (socket) => {
    const userId = socket.userId;

    socket.on("join_parkour_room", async (payload, ack) => {
      try {
        const { raceId, displayName } = payload || {};
        if (!raceId) {
          if (typeof ack === "function") ack({ success: false, reason: "missing_race_id" });
          return;
        }

        const joinResult = await joinRace({
          raceId,
          userId,
          displayName,
          socketId: socket.id,
        });

        let room = parkourRoomManager.getRoom(raceId);
        if (!room) room = await parkourRoomManager.loadRoom(raceId);
        if (!room) {
          if (typeof ack === "function") ack({ success: false, reason: "race_not_found" });
          return;
        }

        const p = room.game.getPlayer(userId);
        if (p) p.socketId = socket.id;
        parkourRoomManager.bindUser(userId, raceId, socket.id);
        socket.join(parkourRoomName(raceId));

        const state = room.game.getPublicState(userId);
        socket.emit("room_state", state);
        broadcastRoomState(nsp, room);

        if (typeof ack === "function") {
          ack({ success: true, raceId, seatIndex: joinResult?.seatIndex, state: room.game.state });
        }
      } catch (err) {
        logger.error("join_parkour_room_error", { userId, reason: err?.message });
        if (typeof ack === "function") {
          ack({ success: false, reason: err?.message || "join_failed" });
        }
      }
    });

    socket.on("ready", async (payload, ack) => {
      const { raceId, ready = true } = payload || {};
      const rid = raceId || parkourRoomManager.getRaceIdForUser(userId);
      const room = rid ? parkourRoomManager.getRoom(rid) : null;
      if (!room) {
        if (typeof ack === "function") ack({ success: false, reason: "not_in_race" });
        return;
      }

      const result = room.game.setReady(userId, ready);
      if (!result.success) {
        if (typeof ack === "function") ack(result);
        return;
      }

      await room.persist();
      broadcastRoomState(nsp, room);
      if (typeof ack === "function") ack({ success: true, ready: result.ready });

      if (room.game.allReady()) startCountdownFlow(nsp, room);
    });

    socket.on("player_position", async (payload) => {
      const { raceId, position, nonce } = payload || {};
      const rid = raceId || parkourRoomManager.getRaceIdForUser(userId);
      const room = rid ? parkourRoomManager.getRoom(rid) : null;
      if (!room) return;

      const result = room.game.updatePosition(userId, position, nonce);
      if (!result.success && result.reason !== "position_spam") {
        emitToPlayer(nsp, socket.id, "anti_cheat_violation", {
          reason: result.reason,
          ...result,
        });
      }
    });

    socket.on("checkpoint_reached", async (payload, ack) => {
      const { raceId, checkpointIndex, position, nonce } = payload || {};
      const rid = raceId || parkourRoomManager.getRaceIdForUser(userId);
      const room = rid ? parkourRoomManager.getRoom(rid) : null;
      if (!room) {
        if (typeof ack === "function") ack({ success: false, reason: "not_in_race" });
        return;
      }

      const result = room.game.reachCheckpoint(userId, checkpointIndex, position, nonce);
      if (!result.success) {
        if (["wrong_checkpoint_order", "impossible_speed", "teleport_detected", "replay_nonce"].includes(result.reason)) {
          emitToPlayer(nsp, socket.id, "anti_cheat_violation", result);
        }
        if (typeof ack === "function") ack(result);
        return;
      }

      await room.persist();
      emitToRaceHumans(nsp, room, "player_progress", {
        userId,
        checkpointIndex: result.checkpointIndex,
        respawn: result.respawn,
      });
      if (typeof ack === "function") ack(result);
    });

    socket.on("finish_race", async (payload, ack) => {
      const { raceId, position, nonce } = payload || {};
      const rid = raceId || parkourRoomManager.getRaceIdForUser(userId);
      const room = rid ? parkourRoomManager.getRoom(rid) : null;
      if (!room) {
        if (typeof ack === "function") ack({ success: false, reason: "not_in_race" });
        return;
      }

      const result = room.game.finishRace(userId, position, nonce);
      if (!result.success) {
        if (result.reason !== "already_finished") {
          emitToPlayer(nsp, socket.id, "anti_cheat_violation", result);
        }
        if (typeof ack === "function") ack(result);
        return;
      }

      await room.persist();
      emitToRaceHumans(nsp, room, "player_finished", {
        userId: result.userId,
        seatIndex: result.seatIndex,
        finishOrder: result.finishOrder,
        finishTimeMs: result.finishTimeMs,
      });
      broadcastRoomState(nsp, room);
      if (typeof ack === "function") ack(result);

      if (room.game.isRaceComplete()) {
        await finishRaceFlow(nsp, room, "all_finished");
      }
    });

    socket.on("disconnect", async () => {
      const rid = parkourRoomManager.getRaceIdForUser(userId);
      if (!rid) return;
      const room = parkourRoomManager.getRoom(rid);
      if (!room) return;

      room.game.markDisconnected(userId);
      await room.persist();
      emitToRaceHumans(nsp, room, "player_progress", {
        userId,
        status: "disconnected",
      });

      if (!room.timers.length && ["playing", "countdown", "starting"].includes(room.game.state)) {
        scheduleRaceTick(nsp, room);
      }
    });

    socket.on("parkour_reconnect", async (payload, ack) => {
      const { raceId } = payload || {};
      const rid = raceId || parkourRoomManager.getRaceIdForUser(userId);
      let room = rid ? parkourRoomManager.getRoom(rid) : null;
      if (!room && rid) room = await parkourRoomManager.loadRoom(rid);
      if (!room) {
        if (typeof ack === "function") ack({ success: false, reason: "race_not_found" });
        return;
      }

      const result = room.game.reconnect(userId, socket.id);
      if (!result.success) {
        if (typeof ack === "function") ack(result);
        return;
      }

      parkourRoomManager.bindUser(userId, rid, socket.id);
      socket.join(parkourRoomName(rid));
      socket.emit("room_state", room.game.getPublicState(userId));
      if (typeof ack === "function") ack({ success: true, ...result });
    });
  });
}

/** Resume timers for races restored after server restart. */
function resumeRestoredRaces(nsp) {
  for (const room of parkourRoomManager.listActiveRooms()) {
    const game = room.game;
    if (["countdown", "starting", "playing"].includes(game.state)) {
      scheduleRaceTick(nsp, room);
    }
    if (game.state === "finished" || game.state === "settlement_pending") {
      finishRaceFlow(nsp, room, "recovery").catch((err) => {
        logger.error("parkour_recovery_finish_failed", { raceId: game.raceId, reason: err?.message });
      });
    }
  }
}

module.exports = { registerParkourHandlers, resumeRestoredRaces, finishRaceFlow };
