const mongoose = require("mongoose");

const dbConnection = async () => {
  const uri =
    process.env.DB_URI || process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/game";
  if (!uri && process.env.NODE_ENV === "production") {
    throw new Error("MONGO_URI_MISSING");
  }
  const conn = await mongoose.connect(uri);
  console.log(`Database Connected: ${conn.connection.host}`);
  return conn;
};

module.exports = dbConnection;
