const jwt = require("jsonwebtoken");
const User = require("../models/userModel");

function getTokenFromHandshake(socket) {
  const auth = socket.handshake.auth || {};
  if (auth.token) return auth.token.replace(/^Bearer\s+/i, "");
  const header = socket.handshake.headers && socket.handshake.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.split(" ")[1];
  const query = socket.handshake.query || {};
  if (query.token) return String(query.token).replace(/^Bearer\s+/i, "");
  return null;
}

async function verifySocketToken(token) {
  if (!token) {
    throw new Error("Authentication token missing");
  }
  const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
  if (!decoded || !decoded.userId) {
    throw new Error("Invalid token");
  }

  const user = await User.findById(decoded.userId).select(
    "_id active sessionVersion passwordChangedAt role"
  );
  if (!user) {
    throw new Error("User no longer exists");
  }
  if (user.active === false) {
    throw new Error("Account is deactivated or suspended");
  }
  if (user.passwordChangedAt) {
    const passChangedTimestamp = parseInt(user.passwordChangedAt.getTime() / 1000, 10);
    if (passChangedTimestamp > decoded.iat) {
      throw new Error("User recently changed password");
    }
  }
  const tokenSession = Math.floor(Number(decoded.sessionVersion) || 0);
  const userSession = Math.floor(Number(user.sessionVersion) || 0);
  if (tokenSession !== userSession) {
    throw new Error("Session expired");
  }

  return { user, decoded };
}

function socketAuthMiddleware(socket, next) {
  const token = getTokenFromHandshake(socket);
  if (!token) return next(new Error("Authentication token missing"));

  verifySocketToken(token)
    .then(({ user, decoded }) => {
      socket.userId = decoded.userId;
      socket.user = user;
      socket.data = socket.data || {};
      socket.data.userId = decoded.userId;
      socket.data.user = user;
      next();
    })
    .catch((err) => {
      next(new Error(err.message || "Invalid token"));
    });
}

module.exports = {
  getTokenFromHandshake,
  verifySocketToken,
  socketAuthMiddleware,
};
