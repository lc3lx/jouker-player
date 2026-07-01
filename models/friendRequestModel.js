const mongoose = require("mongoose");

const friendRequestSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    to: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    message: { type: String, maxlength: 200, trim: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "cancelled"],
      default: "pending",
      index: true,
    },
    respondedAt: Date,
  },
  { timestamps: true }
);

friendRequestSchema.index({ from: 1, to: 1, status: 1 });

module.exports = mongoose.model("FriendRequest", friendRequestSchema);
