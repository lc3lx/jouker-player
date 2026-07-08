const mongoose = require("mongoose");

const supportMessageSchema = new mongoose.Schema(
  {
    ticket: {
      type: mongoose.Schema.ObjectId,
      ref: "SupportTicket",
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
      enum: ["user", "admin", "manager", "system"],
      default: "user",
    },
    body: { type: String, required: true, maxlength: 2000 },
    readByUser: { type: Boolean, default: false },
    readByStaff: { type: Boolean, default: false },
  },
  { timestamps: true }
);

supportMessageSchema.index({ ticket: 1, createdAt: 1 });

module.exports = mongoose.model("SupportMessage", supportMessageSchema);
