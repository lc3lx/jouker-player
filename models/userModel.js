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

    /** Invalidates JWTs on logout-all / password change (checked in auth protect). */
    sessionVersion: { type: Number, default: 0, min: 0 },
    preferences: {
      language: { type: String, enum: ["ar", "en"], default: "ar" },
      notifications: { type: Boolean, default: true },
      soundEffects: { type: Boolean, default: true },
      twoFactorEnabled: { type: Boolean, default: false },
      hideProfile: { type: Boolean, default: false },
      loginAlerts: { type: Boolean, default: true },
    },
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
    // Referred by (agent/promoter user or friend invite)
    referredBy: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      index: true,
    },
    /** Friend invite code — every user gets one at signup. */
    inviteCode: {
      type: String,
      unique: true,
      sparse: true,
      uppercase: true,
      index: true,
    },
    referralMeta: {
      linkedAt: Date,
      source: String,
      deviceFingerprint: String,
      appInstanceId: String,
      registrationIp: String,
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
    /** Phase 2: time-limited VIP subscription. */
    vip: {
      active:    { type: Boolean, default: false },
      expiresAt: { type: Date },
    },
  },
  { timestamps: true }
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  // Hashing user password
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.index({ referredBy: 1, createdAt: -1 });
userSchema.index({ "referralMeta.deviceFingerprint": 1 }, { sparse: true });
userSchema.index({ "referralMeta.registrationIp": 1 }, { sparse: true });

const User = mongoose.model("User", userSchema);

module.exports = User;
