const mongoose = require("mongoose");

const dbConnection = async () => {
  const uri =
    process.env.DB_URI || process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/game";
  if (!uri && process.env.NODE_ENV === "production") {
    throw new Error("MONGO_URI_MISSING");
  }
  // A half-open connection must not hold a game/wallet lock indefinitely.
  // Let the driver abort failed I/O; never release financial locks with a
  // Promise.race while the underlying write could still be running.
  const conn = await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    waitQueueTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 30000,
  });
  console.log(`Database Connected: ${conn.connection.host}`);
  return conn;
};

module.exports = dbConnection;
