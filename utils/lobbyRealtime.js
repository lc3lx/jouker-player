const logger = require("./logger");

/** Main Socket.IO server ref for lobby-wide events (tables list refresh). */
let mainIo = null;

function setMainIo(io) {
  mainIo = io;
}

function getMainIo() {
  return mainIo;
}

function emitTablesUpdated(payload = {}) {
  if (!mainIo) return;
  try {
    mainIo.emit("tables_updated", {
      at: new Date().toISOString(),
      ...payload,
    });
  } catch (err) {
    logger.warn("lobby_emit_tables_updated_failed", { reason: err?.message || "unknown" });
  }
}

module.exports = { setMainIo, getMainIo, emitTablesUpdated };
