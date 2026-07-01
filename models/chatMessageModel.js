const mongoose = require("mongoose");

const chatMessageSchema = new mongoose.Schema(
  {
    channel: {
      type: String,
      enum: ["global", "lobby", "table", "private", "friend"],
      required: true,
      index: true,
    },
    channelId: { type: String, required: true, index: true },
    sender: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    recipient: { type: mongoose.Schema.ObjectId, ref: "User" },
    body: { type: String, maxlength: 2000, trim: true },
    emoji: { type: String, maxlength: 32 },
    deleted: { type: Boolean, default: false },
    reported: { type: Boolean, default: false },
    reportReason: { type: String, maxlength: 500 },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

chatMessageSchema.index({ channel: 1, channelId: 1, createdAt: -1 });

module.exports = mongoose.model("ChatMessage", chatMessageSchema);
