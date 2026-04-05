const jwt = require('jsonwebtoken');

const createToken = (payload) =>
  jwt.sign(
    { userId: payload },
    process.env.JWT_SECRET_KEY || 'dev-secret',
    {
      expiresIn: process.env.JWT_EXPIRE_TIME || '30d',
    }
  );

module.exports = createToken;
