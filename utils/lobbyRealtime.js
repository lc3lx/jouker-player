/** Main Socket.IO server ref for lobby-wide events (tables list refresh). */
let mainIo = null;

function setMainIo(io) {
  mainIo = io;
}

function emitTablesUpdated(payload = {}) {
  if (!mainIo) return;
  try {
    mainIo.emit("tables_updated", {
      at: new Date().toISOString(),
      ...payload,
    });
  } catch (_) {
    // ignore emit errors
  }
}

module.exports = { setMainIo, emitTablesUpdated };
