const mongoose = require("mongoose");

const supportTicketSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    subject: { type: String, default: "طلب دعم فني", trim: true, maxlength: 120 },
    status: {
      type: String,
      enum: ["open", "pending", "closed"],
      default: "open",
      index: true,
    },
    assignedTo: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastMessagePreview: { type: String, default: "", maxlength: 200 },
    unreadForUser: { type: Number, default: 0, min: 0 },
    unreadForStaff: { type: Number, default: 0, min: 0 },
    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

supportTicketSchema.index({ user: 1, status: 1, updatedAt: -1 });
supportTicketSchema.index({ status: 1, lastMessageAt: -1 });

module.exports = mongoose.model("SupportTicket", supportTicketSchema);
