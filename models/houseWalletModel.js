const mongoose = require("mongoose");

const houseWalletSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: "house-main",
    },
    balance: {
      type: Number,
      required: true,
      default: 0,
      min: [0, "House wallet balance cannot be negative"],
    },
    lockedBalance: {
      type: Number,
      required: true,
      default: 0,
      min: [0, "House wallet lockedBalance cannot be negative"],
    },
    currency: {
      type: String,
      default: "CHIPS",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("HouseWallet", houseWalletSchema);
