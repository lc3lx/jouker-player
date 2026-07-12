const mongoose = require("mongoose");

const miniGamePlaySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: [
        "golden-eagle-slot",
        "fruit-slot",
        "thunder-king",
        "lucky-dice",
        "king-arth",
        "sicbo",
      ],
      required: true,
    },
    bet: { type: Number, required: true, min: 0 },
    payout: { type: Number, required: true, min: 0 },
    profit: { type: Number, required: true },
    result: { type: String }, // e.g. symbols or dice outcome
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MiniGamePlay", miniGamePlaySchema);
