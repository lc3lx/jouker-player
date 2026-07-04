const logger = require("./logger");

let mainIo = null;

function setMainIo(io) {
  mainIo = io;
}

function emitToNamespace(nsp, event, payload) {
  if (!mainIo) return;
  try {
    mainIo.of(nsp).emit(event, payload);
  } catch (err) {
    logger.warn("island_jackpot_emit_failed", { event, nsp, reason: err?.message });
  }
}

/** Pool / hot-state updates — all poker tables + lobby listeners. */
function broadcastStateUpdate(payload) {
  if (!mainIo) return;
  const envelope = { at: new Date().toISOString(), ...payload };
  try {
    mainIo.emit("island_jackpot_state", envelope);
    emitToNamespace("/table-game", "island_jackpot_state", envelope);
  } catch (err) {
    logger.warn("island_jackpot_state_broadcast_failed", { reason: err?.message });
  }
}

/** Animated pool tick when someone joins. */
function broadcastPoolTick(payload) {
  broadcastStateUpdate({ event: "pool_tick", ...payload });
}

/** Hot jackpot armed — global awareness. */
function broadcastHotJackpot(payload) {
  broadcastStateUpdate({ event: "hot_jackpot", hotJackpot: true, ...payload });
}

/** Global win announcement + celebration payload. */
function broadcastWin(payload) {
  if (!mainIo) return;
  const envelope = { at: new Date().toISOString(), event: "win", ...payload };
  try {
    mainIo.emit("island_jackpot_win", envelope);
    emitToNamespace("/table-game", "island_jackpot_win", envelope);
    mainIo.emit("island_jackpot_global", envelope);
  } catch (err) {
    logger.warn("island_jackpot_win_broadcast_failed", { reason: err?.message });
  }
}

module.exports = {
  setMainIo,
  broadcastStateUpdate,
  broadcastPoolTick,
  broadcastHotJackpot,
  broadcastWin,
};
