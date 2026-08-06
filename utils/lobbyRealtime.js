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
    // A lobby refresh never needs a table id. Omitting it prevents private
    // table identifiers from being leaked through the unauthenticated root
    // Socket.IO broadcast.
    const { tableId: _tableId, ...safePayload } = payload;
    mainIo.emit("tables_updated", {
      at: new Date().toISOString(),
      ...safePayload,
    });
  } catch (err) {
    logger.warn("lobby_emit_tables_updated_failed", { reason: err?.message || "unknown" });
  }
}

module.exports = { setMainIo, getMainIo, emitTablesUpdated };
