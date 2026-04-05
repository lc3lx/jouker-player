const mongoose = require("mongoose");

const analyticsEventSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.ObjectId, ref: "User", index: true },
    props: { type: mongoose.Schema.Types.Mixed },
    source: { type: String, default: "server" },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

analyticsEventSchema.index({ name: 1, createdAt: -1 });

module.exports = mongoose.model("AnalyticsEvent", analyticsEventSchema);
