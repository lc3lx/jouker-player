const mongoose = require("mongoose");

const userBlockSchema = new mongoose.Schema(
  {
    blocker: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    blocked: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
  },
  { timestamps: true }
);

userBlockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });

module.exports = mongoose.model("UserBlock", userBlockSchema);
