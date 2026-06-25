const mongoose = require("mongoose");

const luckyWheelSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    currentStreak: { type: Number, default: 0, min: 0 },
    lastClaimAt: { type: Date, default: null },
    lastSpinDayUtc: { type: String, default: null, index: true },
    lastAccrualAt: { type: Date, default: null },
    nextSpinAt: { type: Date, default: null },
    availableSpins: { type: Number, default: 1, min: 0 },
    lifetimeSpins: { type: Number, default: 0, min: 0 },
    lifetimeTokensWon: { type: Number, default: 0, min: 0 },
    highestRewardWon: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

luckyWheelSchema.statics.getOrCreateByUser = async function getOrCreateByUser(userId, session) {
  const q = this.findOne({ userId });
  let row = session ? await q.session(session) : await q;
  if (row) return row;

  const now = new Date();
  const SPIN_COOLDOWN_MS = 4 * 60 * 60 * 1000;
  const payload = {
    userId,
    currentStreak: 0,
    availableSpins: 1,
    lastAccrualAt: now,
    nextSpinAt: new Date(now.getTime() + SPIN_COOLDOWN_MS),
  };

  if (session) {
    [row] = await this.create([payload], { session });
  } else {
    row = await this.create(payload);
  }
  return row;
};

module.exports = mongoose.model("LuckyWheel", luckyWheelSchema);
