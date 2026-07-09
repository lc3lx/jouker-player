/**
 * Backfill inviteCode for users missing one.
 * Usage: node backend/scripts/backfillInviteCodes.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const dbConnection = require("../config/database");
const User = require("../models/userModel");
const referralInviteService = require("../modules/referral/services/referralInviteService");

async function main() {
  await dbConnection();
  const users = await User.find({
    $or: [{ inviteCode: { $exists: false } }, { inviteCode: null }, { inviteCode: "" }],
  }).select("_id");

  let n = 0;
  for (const u of users) {
    await referralInviteService.ensureInviteCode(u._id);
    n += 1;
  }
  console.log(`Invite codes synced for ${n} users.`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
