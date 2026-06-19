/**
 * Game Server Socket - namespace /game
 * JWT auth, game handlers (join_game, bid, play_card, leave_room)
 */
const jwt = require("jsonwebtoken");
const { registerGameHandlers, getTokenFromHandshake } = require("./handlers/game.handlers");
const kingArthRoundState = require("../games/dice/kingArthRoundState");
const kingArthSeedRotation = require("../games/dice/kingArthSeedRotation");
const kingArthAnalytics = require("../games/dice/kingArthAnalytics");

function initGameServer(io, gameOptions = {}) {
  const redis = gameOptions.redis || null;
  kingArthRoundState.setRedisClient(redis);
  kingArthSeedRotation.setRedisClient(redis);
  kingArthAnalytics.setRedisClient(redis);

  const nsp = io.of("/game");

  // Auth middleware - extract JWT, set socket.user
  nsp.use((socket, next) => {
    try {
      const token = getTokenFromHandshake(socket);
      if (!token) return next(new Error("Authentication token missing"));
      const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
      socket.userId = decoded.userId;
      socket.user = { id: decoded.userId };
      next();
    } catch (err) {
      next(new Error("Invalid token"));
    }
  });

  registerGameHandlers(nsp);
}

module.exports = { initGameServer };
