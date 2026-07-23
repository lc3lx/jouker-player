const mongoose = require("mongoose");

/** A scheduled clan event (poker night, weekly trix, meeting…). Members RSVP. */
const clanEventSchema = new mongoose.Schema(
  {
    clan: { type: mongoose.Schema.ObjectId, ref: "Clan", required: true, index: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: [
        "poker_night",
        "weekly_trix",
        "tarneeb_championship",
        "training",
        "meeting",
        "custom",
      ],
      default: "custom",
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: "", maxlength: 500, trim: true },
    game: { type: String, enum: ["poker", "trix", "tarneeb41", null], default: null },
    scheduledAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ["scheduled", "live", "finished", "cancelled"],
      default: "scheduled",
      index: true,
    },
    attendees: [{ type: mongoose.Schema.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

clanEventSchema.index({ clan: 1, scheduledAt: 1 });

module.exports = mongoose.model("ClanEvent", clanEventSchema);
