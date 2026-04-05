const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      required: [true, "name required"],
    },
    slug: {
      type: String,
      lowercase: true,
    },
    email: {
      type: String,
      required: [true, "email required"],
      unique: true,
      lowercase: true,
    },
    country: {
      type: String,
      uppercase: true,
      trim: true,
    },
    phone: String,
    profileImg: String,

    password: {
      type: String,
      required: [true, "password required"],
      minlength: [6, "Too short password"],
    },
    passwordChangedAt: Date,
    passwordResetCode: String,
    passwordResetExpires: Date,
    passwordResetVerified: Boolean,
    role: {
      type: String,
      enum: ["user", "manager", "admin"],
      default: "user",
    },
    active: {
      type: Boolean,
      default: true,
    },
    // child reference (one to many)
    wishlist: [
      {
        type: mongoose.Schema.ObjectId,
        ref: "Product",
      },
    ],
    addresses: [
      {
        id: { type: mongoose.Schema.Types.ObjectId },
        alias: String,
        details: String,
        phone: String,
        city: String,
        postalCode: String,
      },
    ],
    // Wallet reference
    wallet: {
      type: mongoose.Schema.ObjectId,
      ref: "Wallet",
    },
    // Referred by (agent/promoter user)
    referredBy: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      index: true,
    },
    /** Poker retention / stats (authoritative increments on hand settlement). */
    pokerHandsPlayed: { type: Number, default: 0, min: 0 },
    pokerHandsWon: { type: Number, default: 0, min: 0 },
    lastDailyBonusAt: { type: Date },
    /** Consecutive UTC days daily bonus claimed (streak). */
    dailyBonusStreak: { type: Number, default: 0, min: 0 },
    lastDailyBonusDayUtc: { type: String },
    /** Consecutive poker hands won (settled with share > 0). */
    pokerWinStreak: { type: Number, default: 0, min: 0 },
    /** Fraud / trust — payments & high-risk actions blocked when true. */
    trustRestricted: { type: Boolean, default: false },
    suspiciousFlag: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  // Hashing user password
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

const User = mongoose.model("User", userSchema);

module.exports = User;
