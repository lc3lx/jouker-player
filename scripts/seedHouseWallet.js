require("dotenv").config();
const mongoose = require("mongoose");
const HouseWallet = require("../models/houseWalletModel");

async function main() {
  const uri = process.env.DB_URI || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI_MISSING");
  await mongoose.connect(uri);
  try {
    const key = process.env.HOUSE_WALLET_KEY || "house-main";
    const initialBalance = Math.max(0, Math.floor(Number(process.env.HOUSE_WALLET_INITIAL_BALANCE || 0)));
    const wallet = await HouseWallet.findOneAndUpdate(
      { key },
      {
        $setOnInsert: {
          key,
          balance: initialBalance,
          lockedBalance: 0,
          currency: "CHIPS",
          isActive: true,
        },
      },
      { new: true, upsert: true }
    );
    console.log("house_wallet_seeded", {
      key: wallet.key,
      balance: wallet.balance,
      created: wallet.balance === initialBalance,
    });
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("seedHouseWallet failed:", err?.message || err);
  process.exit(1);
});
