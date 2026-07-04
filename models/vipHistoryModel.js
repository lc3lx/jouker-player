const mongoose = require("mongoose");
const { VIP_LEVELS } = require("../config/vipConfig");

/** VIPHistory — append-only audit trail of every VIP membership event. */
const vipHistorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: [
        "purchase",
        "upgrade",
        "downgrade",
        "renewal",
        "expiration",
        "refund",
        "admin_gift",
        "admin_remove",
        "admin_extend",
        "admin_change_level",
        "cancel",
        "restore",
      ],
      required: true,
      index: true,
    },
    level: { type: String, enum: [...VIP_LEVELS, null], default: null },
    previousLevel: { type: String, enum: [...VIP_LEVELS, null], default: null },
    provider: {
      type: String,
      enum: ["google_play", "apple", "stripe", "admin", "restore", null],
      default: null,
    },
    priceCents: { type: Number, default: 0 },
    expireDate: { type: Date },
    providerRef: { type: String },
    /** Admin user for admin_* actions. */
    actorId: { type: mongoose.Schema.ObjectId, ref: "User" },
    note: { type: String },
    meta: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

vipHistorySchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("VIPHistory", vipHistorySchema);
