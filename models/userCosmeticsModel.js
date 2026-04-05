const mongoose = require("mongoose");

const userCosmeticsSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    ownedItems: [{ type: mongoose.Schema.ObjectId, ref: "Cosmetic" }],
    equipped: {
      tableTheme: { type: mongoose.Schema.ObjectId, ref: "Cosmetic", default: null },
      cardSkin: { type: mongoose.Schema.ObjectId, ref: "Cosmetic", default: null },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("UserCosmetics", userCosmeticsSchema);
