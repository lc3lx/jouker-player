const mongoose = require("mongoose");

const depositMessageSchema = new mongoose.Schema(
  {
    ticket: {
      type: mongoose.Schema.ObjectId,
      ref: "DepositTicket",
      required: true,
      index: true,
    },
    sender: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    senderRole: {
      type: String,
      enum: ["user", "agent", "admin", "system"],
      default: "user",
    },
    type: {
      type: String,
      enum: ["text", "image", "system"],
      default: "text",
    },
    body: { type: String, default: "", maxlength: 2000 },
    imageUrl: { type: String, default: "" },
    readByUser: { type: Boolean, default: false },
    readByAgent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

depositMessageSchema.index({ ticket: 1, createdAt: 1 });

module.exports = mongoose.model("DepositMessage", depositMessageSchema);
