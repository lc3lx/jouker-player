const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ["task", "bonus", "tournament", "friend", "wallet", "system", "other"],
      default: "other",
      index: true,
    },
    title: { type: String, required: true },
    subtitle: { type: String, default: "" },
    icon: { type: String, default: "default" },
    isRead: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
    sourceType: { type: String, default: "", index: true },
    sourceId: { type: String, default: "", index: true },
    meta: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index(
  { userId: 1, sourceType: 1, sourceId: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
