const jwt = require('jsonwebtoken');

function getJwtSecret() {
  if (!process.env.JWT_SECRET_KEY) {
    throw new Error("JWT_SECRET_KEY_MISSING");
  }
  return process.env.JWT_SECRET_KEY;
}

const createToken = (userId, sessionVersion = 0) =>
  jwt.sign(
    {
      userId,
      sessionVersion: Math.floor(Number(sessionVersion) || 0),
    },
    getJwtSecret(),
    {
      expiresIn: process.env.JWT_EXPIRE_TIME || '30d',
    }
  );

module.exports = createToken;
