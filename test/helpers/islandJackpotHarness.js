"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { resetMongoTransactionProbeForTests } = require("../../services/walletLedgerService");
const { resetCacheForTests } = require("../../utils/islandJackpotCache");

const IslandPool = require("../../models/islandPoolModel");
const IslandMember = require("../../models/islandMemberModel");
const IslandWinner = require("../../models/islandWinnerModel");
const IslandHistory = require("../../models/islandHistoryModel");
const JackpotTransaction = require("../../models/jackpotTransactionModel");
const User = require("../../models/userModel");
const Wallet = require("../../models/walletModel");

/** Verified card sets for integration payout tests. */
const ISLAND_HANDS = {
  royalFlush: {
    hole: ["Ah", "Kh"],
    community: ["Qh", "Jh", "Th", "2d", "3c"],
  },
  straightFlush: {
    hole: ["9h", "8h"],
    community: ["7h", "6h", "5h", "2d", "3c"],
  },
  fourOfAKind: {
    hole: ["Ah", "Ad"],
    community: ["Ac", "As", "2h", "3d", "4c"],
  },
};

class IslandJackpotHarness {
  constructor() {
    this.replSet = null;
    this._savedEnv = {};
  }

  async start() {
    this._savedEnv = {
      MONGODB_URI: process.env.MONGODB_URI,
      MONGO_URI: process.env.MONGO_URI,
      DB_URI: process.env.DB_URI,
      MONGO_STANDALONE: process.env.MONGO_STANDALONE,
      ISLAND_JACKPOT_ENABLED: process.env.ISLAND_JACKPOT_ENABLED,
      NODE_ENV: process.env.NODE_ENV,
    };

    process.env.NODE_ENV = "test";
    process.env.ISLAND_JACKPOT_ENABLED = "true";
    delete process.env.MONGO_STANDALONE;

    this.replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    const uri = this.replSet.getUri();
    process.env.MONGODB_URI = uri;
    delete process.env.MONGO_URI;
    delete process.env.DB_URI;

    resetMongoTransactionProbeForTests();
    resetCacheForTests();

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(uri, { dbName: "island_jackpot_test" });

    // Lazy-load service after mongoose connect so txn probe uses replica set.
    delete require.cache[require.resolve("../../services/islandJackpotService")];
    this.service = require("../../services/islandJackpotService");
  }

  async stop() {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
    if (this.replSet) {
      await this.replSet.stop();
      this.replSet = null;
    }
    resetMongoTransactionProbeForTests();
    resetCacheForTests();
    this.service.resetJoinCooldownForTests?.();

    for (const [k, v] of Object.entries(this._savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  async clearAll() {
    await Promise.all([
      IslandPool.deleteMany({}),
      IslandMember.deleteMany({}),
      IslandWinner.deleteMany({}),
      IslandHistory.deleteMany({}),
      JackpotTransaction.deleteMany({}),
      Wallet.deleteMany({}),
      User.deleteMany({}),
    ]);
    resetCacheForTests();
    this.service.resetJoinCooldownForTests?.();
  }

  async createUser({ name = "Player", balance = 10_000_000, email = null } = {}) {
    const id = crypto.randomUUID().slice(0, 8);
    const user = await User.create({
      name,
      email: email || `player-${id}@test.local`,
      password: "testpass123",
      role: "user",
    });
    await Wallet.create({ user: user._id, balance, lockedBalance: 0 });
    return user;
  }

  async getWalletBalance(userId) {
    const w = await Wallet.findOne({ user: userId }).lean();
    return w?.balance ?? 0;
  }

  async getPool() {
    return IslandPool.getSingleton();
  }

  async configurePool({
    minTriggerAmount = 100_000,
    entryFee = 10_000,
    poolBalance = 0,
    maxWinnersPerEvent = 1,
    hotJackpotThreshold = 0,
    payoutPercentages = {},
  } = {}) {
    await IslandPool.deleteMany({});
    const pool = await IslandPool.create({
      key: "default",
      enabled: true,
      minTriggerAmount,
      entryFee,
      poolBalance,
      payoutPercentages: {
        royalFlush: 0.8,
        straightFlush: 0.3,
        fourOfAKind: 0.2,
        ...payoutPercentages,
      },
      payoutPolicy: { maxWinnersPerEvent, requireShowdown: true },
      settings: { hotJackpotThreshold, effectsEnabled: true, announcementsEnabled: true },
      stats: { peakPoolBalance: poolBalance, totalEntries: 0, totalPaidOut: 0, totalWinners: 0 },
    });
    pool.armed = poolBalance >= minTriggerAmount;
    pool.hotJackpot =
      poolBalance >= (hotJackpotThreshold > 0 ? hotJackpotThreshold : minTriggerAmount);
    await pool.save();
    resetCacheForTests();
    return pool;
  }

  async joinMember(user, { idempotencyKey = null } = {}) {
    return this._invokeHandler(this.service.joinIslandJackpot, {
      user: { _id: user._id },
      headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
      body: {},
    });
  }

  async onHandSettled(params) {
    await this.service.onHandSettled(params);
  }

  buildSeat(user, handKey, { folded = false, isBot = false } = {}) {
    const cards = ISLAND_HANDS[handKey];
    return {
      userId: user._id,
      name: user.name,
      hole: [...cards.hole],
      folded,
      isBot,
    };
  }

  async _invokeHandler(handler, req) {
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(data) {
          resolve({ statusCode: this.statusCode, data });
          return this;
        },
      };
      const next = (err) => reject(err);
      Promise.resolve(handler(req, res, next)).catch(reject);
    });
  }
}

async function withHarness(fn) {
  const harness = new IslandJackpotHarness();
  await harness.start();
  try {
    await harness.clearAll();
    await fn(harness);
  } finally {
    await harness.stop();
  }
}

module.exports = {
  IslandJackpotHarness,
  withHarness,
  ISLAND_HANDS,
};
