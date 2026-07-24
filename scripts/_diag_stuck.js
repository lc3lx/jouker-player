// TEMP read-only diagnostic. Deleted after use.
require("dotenv").config();
const mongoose = require("mongoose");
const dbConnection = require("../config/database");
const User = require("../models/userModel");

const ids = ["69baa3bdea4ff016f8a2b17a", "6a3321f4185eda685fcbad55"];

(async () => {
  await dbConnection();
  for (const id of ids) {
    const u = await User.findById(id).select("_id email username walletBalance lockedBalance isBot");
    console.log(u ? JSON.stringify({
      _id: String(u._id),
      email: u.email,
      username: u.username,
      isBot: u.isBot,
      walletBalance: u.walletBalance,
      lockedBalance: u.lockedBalance,
    }, null, 2) : `${id}: not found`);
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
