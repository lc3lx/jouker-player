const mongoose = require("mongoose");

/**
 * One player's verdict on one completed deposit.
 *
 * Ratings hang off a **ticket**, not off an agent, and that is the whole
 * integrity story: a ticket exists only because money actually moved between
 * these two people, and the unique index below means it can be rated once.
 * Rating an agent you never dealt with, or rating the same deal twice to move
 * their average, are both impossible by construction rather than by a check
 * someone has to remember to write.
 */
const agentRatingSchema = new mongoose.Schema(
  {
    /** The deal being rated. Unique — one verdict per completed deposit. */
    ticket: {
      type: mongoose.Schema.ObjectId,
      ref: "DepositTicket",
      required: true,
      unique: true,
    },
    /** Who left it. Always the ticket's own user; stored for listing. */
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
    stars: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    comment: { type: String, default: "", trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

/** Listing an agent's reviews, newest first. */
agentRatingSchema.index({ agentProfile: 1, createdAt: -1 });

module.exports = mongoose.model("AgentRating", agentRatingSchema);
