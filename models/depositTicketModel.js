const mongoose = require("mongoose");

/**
 * One agent-deposit request. Owns a private chat (DepositMessage) between the
 * requesting user and the assigned agent; approval moves coins atomically
 * from the agent's wallet to the user's wallet.
 */
const DEPOSIT_STATUSES = Object.freeze([
  "pending", // created, waiting for the agent to accept
  "accepted", // agent accepted the request
  "waiting_payment", // agent shared payment details, waiting for user to pay
  "receipt_uploaded", // user uploaded a payment receipt
  "reviewing", // agent is approving (transfer lock state)
  "completed", // coins transferred or VIP activated
  "rejected", // agent rejected
  "cancelled", // user cancelled / admin force-closed
]);

const TICKET_TYPES = Object.freeze(["deposit", "vip"]);

const ACTIVE_STATUSES = Object.freeze([
  "pending",
  "accepted",
  "waiting_payment",
  "receipt_uploaded",
  "reviewing",
]);

const depositTicketSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    agentProfile: {
      type: mongoose.Schema.ObjectId,
      ref: "AgentProfile",
      required: true,
      index: true,
    },
    agentUser: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    country: { type: String, required: true, uppercase: true, trim: true },
    /** `deposit` = coin credit; `vip` = VIP membership activation. */
    ticketType: {
      type: String,
      enum: TICKET_TYPES,
      default: "deposit",
      index: true,
    },
    /** VIP tier when ticketType is vip (bronze/silver/gold/platinum). */
    vipLevel: { type: String, default: null, trim: true, lowercase: true },
    /** Store price snapshot for VIP tickets. */
    priceUsd: { type: Number, default: null, min: 0 },
    amountRequested: { type: Number, required: true, min: 0 },
    amountApproved: { type: Number, default: null },
    currency: { type: String, default: "", trim: true, maxlength: 12 },
    paymentMethod: { type: String, default: "", trim: true, maxlength: 60 },
    status: {
      type: String,
      enum: DEPOSIT_STATUSES,
      default: "pending",
      index: true,
    },
    receipts: [
      {
        url: { type: String, required: true },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastMessagePreview: { type: String, default: "", maxlength: 200 },
    unreadForUser: { type: Number, default: 0, min: 0 },
    unreadForAgent: { type: Number, default: 0, min: 0 },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.ObjectId, ref: "User", default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.ObjectId, ref: "User", default: null },
    closeReason: { type: String, default: "", maxlength: 300 },
    meta: {
      ip: { type: String, default: "" },
      userAgent: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

depositTicketSchema.index({ user: 1, status: 1, updatedAt: -1 });
depositTicketSchema.index({ agentUser: 1, status: 1, lastMessageAt: -1 });
depositTicketSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("DepositTicket", depositTicketSchema);
module.exports.DEPOSIT_STATUSES = DEPOSIT_STATUSES;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
module.exports.TICKET_TYPES = TICKET_TYPES;
