const mongoose = require("mongoose");

/** In-game player report (from the profile popup) — reviewed by support. */
const playerReportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    reported: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    tableId: { type: String, default: null },
    gameType: { type: String, default: null },
    reason: { type: String, default: "unspecified", maxlength: 300 },
    status: {
      type: String,
      enum: ["open", "reviewed", "dismissed", "actioned"],
      default: "open",
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PlayerReport", playerReportSchema);
