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

/**
 * The pair index below keys on positions, so it only recognises a duplicate when
 * both rows store the users in the same order. Sorting here means that holds for
 * every writer, not just the ones that remember to call pairKey().
 */
friendshipSchema.pre("validate", function sortUsers(next) {
  if (Array.isArray(this.users) && this.users.length === 2) {
    const [x, y] = this.users;
    if (String(x) > String(y)) this.users = [y, x];
  }
  next();
});

/**
 * Pair uniqueness, NOT per-user uniqueness.
 *
 * `index({ users: 1 }, { unique: true })` looks right but `users` is an array,
 * so Mongo builds a MULTIKEY index and indexes each element on its own. Once a
 * user appeared in one friendship, every later friendship containing them hit
 * E11000 — in practice every account was capped at exactly one friend and the
 * second accept returned a 500.
 *
 * Indexing the two positions instead keys on the pair itself. It is safe because
 * friendService.pairKey always writes the users sorted, so a pair has exactly one
 * representation. Dropping the old index is handled by ensureFriendshipIndexes().
 */
friendshipSchema.index(
  { "users.0": 1, "users.1": 1 },
  { unique: true, name: "users_pair_unique" }
);
/** Plain multikey lookup for "every friendship this user is in". */
friendshipSchema.index({ users: 1 }, { name: "users_lookup" });

module.exports = mongoose.model("Friendship", friendshipSchema);
