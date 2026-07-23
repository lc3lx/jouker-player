/**
 * Thin broadcast shim for the Clan system. Services call `emitToClan` /
 * `emitToUser` without depending on the socket layer; sockets/clan.js injects the
 * `/clan` namespace via `setClanIo` at boot. All emits are no-ops until then, so
 * business logic and tests never need a live socket server.
 */
let clanIo = null;

function setClanIo(nsp) {
  clanIo = nsp || null;
}

function emitToClan(clanId, event, payload) {
  if (!clanIo || !clanId) return;
  clanIo.to(`clan:${String(clanId)}`).emit(event, payload);
}

function emitToUser(userId, event, payload) {
  if (!clanIo || !userId) return;
  clanIo.to(`user:${String(userId)}`).emit(event, payload);
}

module.exports = { setClanIo, emitToClan, emitToUser };
