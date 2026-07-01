const mongoose = require("mongoose");

/**
 * Append-only platform audit trail (immutable by convention — no update routes).
 */
const auditLogSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, index: true },
    actor: { type: mongoose.Schema.ObjectId, ref: "User", index: true },
    targetUser: { type: mongoose.Schema.ObjectId, ref: "User", index: true },
    table: { type: mongoose.Schema.ObjectId, ref: "Table", index: true },
    handId: { type: String, index: true },
    tournament: { type: mongoose.Schema.ObjectId, ref: "Tournament" },
    meta: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String },
    userAgent: { type: String },
    prevHash: { type: String },
    hash: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
