const mongoose = require("mongoose");

const friendRequestSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    to: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    message: { type: String, maxlength: 200, trim: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "cancelled"],
      default: "pending",
      index: true,
    },
    respondedAt: Date,
  },
  { timestamps: true }
);

friendRequestSchema.index({ from: 1, to: 1, status: 1 });

/**
 * At most one OPEN request per direction. friendService checks for a pending
 * row before inserting, but two sends landing together both pass that read —
 * this is what actually stops the second one. Answered rows are outside the
 * filter, so a pair can be asked again once the last request is settled.
 * Existing duplicates are folded by ensureFriendshipIndexes() before it builds.
 */
friendRequestSchema.index(
  { from: 1, to: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending" },
    name: "one_pending_per_direction",
  }
);

module.exports = mongoose.model("FriendRequest", friendRequestSchema);
