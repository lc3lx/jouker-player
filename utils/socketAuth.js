/**
 * Shared socket authentication utilities — used by /game, /rtc, and /tableGame namespaces.
 * Extracted to eliminate three identical copies of getTokenFromHandshake.
 */

function getTokenFromHandshake(socket) {
  const auth = socket.handshake.auth || {};
  if (auth.token) return auth.token.replace(/^Bearer\s+/i, "");
  const header = socket.handshake.headers && socket.handshake.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.split(" ")[1];
  const query = socket.handshake.query || {};
  if (query.token) return String(query.token).replace(/^Bearer\s+/i, "");
  return null;
}

module.exports = { getTokenFromHandshake };
