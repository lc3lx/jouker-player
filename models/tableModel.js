const mongoose = require("mongoose");

const seatSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    player: { type: mongoose.Schema.ObjectId, ref: "Player" },
    chips: { type: Number, required: true, min: 0 },
    joinedAt: { type: Date, default: Date.now },
    /** Fixed chair index 0–8 around the table (4 = opposite dealer / bottom). */
    seatPosition: { type: Number, min: 0, max: 8 },
  },
  { _id: false }
);

const waitingQueueEntrySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    player: { type: mongoose.Schema.ObjectId, ref: "Player" },
    buyIn: { type: Number, required: true, min: 0 },
    /** Normalized join metadata reused when the queue entry is later promoted. */
    clientIp: { type: String, default: null },
    deviceId: { type: String, default: null },
    queuedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/** Poker: human left seat — chips held until vacateUntil, then bot or restore. */
const vacatingPlayerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    player: { type: mongoose.Schema.ObjectId, ref: "Player" },
    chips: { type: Number, required: true, min: 0 },
    vacatedAt: { type: Date, default: Date.now },
    vacateUntil: { type: Date, required: true },
    /** Tarneeb41/Trix: fixed seat index when vacated mid-hand. */
    seatIndex: { type: Number, min: 0, max: 3 },
    /** Poker: fixed chair index 0–8 held while vacating (restored on return). */
    seatPosition: { type: Number, min: 0, max: 8 },
  },
  { _id: false }
);

/** Poker: a voluntary leave requested mid-hand; cash-out resumes after settlement. */
const pendingPermanentLeaveSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    requestedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const tableSchema = new mongoose.Schema(
  {
    gameType: {
      type: String,
      enum: ["poker", "trix", "tarneeb41"],
      default: "poker",
      index: true,
    },
    tier: { type: String, enum: ["beginner", "intermediate", "beast", "private"], required: true },
    tableNumber: { type: Number, required: true, index: true },
    smallBlind: { type: Number, required: true, min: 0 },
    bigBlind: { type: Number, required: true, min: 0 },
    minBuyIn: { type: Number, required: true, min: 0 },
    maxBuyIn: { type: Number, required: true, min: 0 },
    /** Poker: display buy-in (defaults to minBuyIn). */
    buyIn: { type: Number, min: 0 },
    /** Poker: minimum opening bet / raise floor (defaults to buyIn / 10). */
    minimumBet: { type: Number, min: 0 },
    /**
     * Per-table rake policy. `cap: 0` deliberately means no cap, preserving
     * legacy behaviour until operations configures caps by stake tier.
     */
    rake: {
      percent: { type: Number, min: 0, max: 0.2 },
      cap: { type: Number, min: 0, default: 0 },
      noFlopNoDrop: { type: Boolean, default: true },
    },
    capacity: { type: Number, default: 9, min: 2, max: 9 },
    seats: [seatSchema],
    /** FIFO waiting list when all seats are taken (poker). */
    waitingQueue: { type: [waitingQueueEntrySchema], default: [] },
    /** Monotonic Redis-lease fencing token for authoritative poker writes. */
    pokerOwnerFence: { type: Number, default: 0, min: 0, index: true },
    /** Humans who vacated a seat — 30s window to return before a bot takes chips. */
    vacatingPlayers: { type: [vacatingPlayerSchema], default: [] },
    /** Durable cash-out intent for a voluntary leave requested mid-hand. */
    pendingPermanentLeaves: { type: [pendingPermanentLeaveSchema], default: [] },
    isPrivate: { type: Boolean, default: false },
    password: { type: String },
    /** Users admitted through an accepted game invitation (passwordless join). */
    allowedUsers: [{ type: mongoose.Schema.ObjectId, ref: "User", index: true }],
    status: {
      type: String,
      enum: ["waiting", "ready", "playing", "full", "frozen", "open", "closed", "archived"],
      default: "waiting",
      index: true,
    },
    /** Set while a game settlement is pending — blocks leaveTable cashout races */
    activeSettlementId: { type: String, default: null, index: true },

    /** Phase 2: explicit table kind — backfilled by ensureFixedTierTables on boot. */
    tableKind: {
      type: String,
      enum: ["static", "dynamic", "vip", "tournament"],
      default: "static",
      index: true,
    },
    /** Lobby display label. "Dynamic #N" for dynamic tables; custom for VIP. */
    displayName: { type: String },
    /** VIP table owner. */
    owner: { type: mongoose.Schema.ObjectId, ref: "User" },
    /**
     * When set, this table is hosting a clan-tournament match. The unified
     * game-finish hook uses this to resolve the match & advance the bracket.
     * Null for all ordinary tables (fully additive / backward compatible).
     */
    clanTournamentMatch: {
      type: mongoose.Schema.ObjectId,
      ref: "ClanTournamentMatch",
      default: null,
      index: true,
    },
    /**
     * When set, this table is hosting a public arena tournament heat.
     * Settlement skips cash (entry is already in escrow) and scores feed the
     * timed ranking. Null for ordinary / clan tables.
     */
    arenaTournament: {
      type: mongoose.Schema.ObjectId,
      ref: "ArenaTournament",
      default: null,
      index: true,
    },
    /** Per-table config knobs controlled by VIP owner or admin. */
    settings: {
      allowSpectators: { type: Boolean, default: true },
      botsEnabled:     { type: Boolean, default: true },
      minPlayers:      { type: Number,  default: 2 },
      maxPlayers:      { type: Number,  default: 9 },
      isLocked:        { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

tableSchema.index({ gameType: 1, tier: 1, tableNumber: 1 }, { unique: true });

tableSchema.pre("save", function capSeatsOnSave(next) {
  if (this.gameType === "poker") {
    this.capacity = Math.min(9, Math.max(2, Number(this.capacity) || 9));
    if (Array.isArray(this.seats) && this.seats.length > this.capacity) {
      return next(new Error("TABLE_CAPACITY_EXCEEDED"));
    }
    if (!Number.isFinite(this.buyIn) || this.buyIn <= 0) {
      this.buyIn = Number(this.minBuyIn) || 0;
    }
    if (!Number.isFinite(this.minimumBet) || this.minimumBet <= 0) {
      this.minimumBet = Math.max(1, Math.floor(Number(this.buyIn || this.minBuyIn || 0) / 10));
    }
  }
  next();
});

module.exports = mongoose.model("Table", tableSchema);
