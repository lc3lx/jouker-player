const mongoose = require("mongoose");

/** Canonical pair: users sorted [minId, maxId] for uniqueness. */
const friendshipSchema = new mongoose.Schema(
  {
    users: {
      type: [{ type: mongoose.Schema.ObjectId, ref: "User" }],
      validate: [(v) => Array.isArray(v) && v.length === 2, "Friendship requires exactly 2 users"],
    },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

friendshipSchema.index({ users: 1 }, { unique: true });

module.exports = mongoose.model("Friendship", friendshipSchema);
