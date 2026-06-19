/**
 * In-memory Mongo harness for trix settlement integration tests.
 * Simulates Table, Wallet, GameSettlement, and ledger application without a live DB.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");

function oid(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (typeof id === "string" && mongoose.Types.ObjectId.isValid(id)) {
    return new mongoose.Types.ObjectId(id);
  }
  return new mongoose.Types.ObjectId();
}

class InMemorySettlementHarness {
  constructor() {
    this.tables = new Map();
    this.wallets = new Map();
    this.settlements = new Map();
    this.transactions = [];
    this.houseWallet = { balance: 0, lockedBalance: 0 };
    this.tableLocks = new Map();
    this._orig = {};
  }

  seedTrixTable({ buyIn = 1000, humanSeats = 2, botSeats = 2 } = {}) {
    const tableId = oid();
    const seats = [];
    const gamePlayers = [];
    for (let i = 0; i < humanSeats; i += 1) {
      const uid = oid();
      seats.push({ user: uid, chips: buyIn });
      gamePlayers.push({
        userId: uid,
        seatIndex: i,
        isBot: false,
        socketId: `s${i}`,
      });
      this.wallets.set(String(uid), {
        userId: uid,
        balance: buyIn * 3,
        lockedBalance: buyIn,
      });
      this.tableLocks.set(`${uid}:${tableId}`, buyIn);
    }
    for (let i = humanSeats; i < humanSeats + botSeats; i += 1) {
      seats.push({ user: oid(), chips: buyIn });
      gamePlayers.push({
        userId: `bot_${i}`,
        seatIndex: i,
        isBot: true,
        socketId: null,
      });
    }
    const table = {
      _id: tableId,
      gameType: "trix",
      status: "open",
      seats,
      activeSettlementId: null,
      tableNumber: 1,
      save: async () => table,
    };
    this.tables.set(String(tableId), table);
    return { tableId, table, gamePlayers };
  }

  installMocks() {
    const Table = require("../../models/tableModel");
    const GameSettlement = require("../../models/gameSettlementModel");
    const WalletTransaction = require("../../models/walletTransactionModel");
    const walletLedger = require("../../services/walletLedgerService");
    const houseWallet = require("../../services/houseWalletService");

    this._orig = {
      TableFindById: Table.findById,
      TableFindOneAndUpdate: Table.findOneAndUpdate,
      TableFindByIdAndUpdate: Table.findByIdAndUpdate,
      GameSettlementFindOne: GameSettlement.findOne,
      GameSettlementCreate: GameSettlement.create,
      WalletTransactionFindOne: WalletTransaction.findOne,
      assertHouseWalletReady: walletLedger.assertHouseWalletReady,
      withMongoTransaction: walletLedger.withMongoTransaction,
      applyGameSettlementDelta: walletLedger.applyGameSettlementDelta,
      recordGameBuyinLedger: walletLedger.recordGameBuyinLedger,
      recordSettlementLedger: walletLedger.recordSettlementLedger,
      setTableLockAmount: walletLedger.setTableLockAmount,
      releaseTableSeatToBalance: walletLedger.releaseTableSeatToBalance,
      applyHouseSettlementDelta: walletLedger.applyHouseSettlementDelta,
      ensureHouseWalletExists: houseWallet.ensureHouseWalletExists,
      applyHouseDelta: houseWallet.applyHouseDelta,
    };

    const self = this;

    Table.findById = function findById(id) {
      const key = String(id);
      const doc = self.tables.get(key);
      const chain = {
        populate: () => chain,
        session: () => chain,
        select: () => chain,
        lean: async () => doc || null,
        then: (resolve, reject) => {
          Promise.resolve(doc || null).then(resolve, reject);
        },
      };
      return chain;
    };

    GameSettlement.findOne = function findOne(query) {
      const matchDoc = async () => {
        for (const doc of self.settlements.values()) {
          let match = true;
          for (const [k, v] of Object.entries(query || {})) {
            if (String(doc[k]) !== String(v)) match = false;
          }
          if (match) return doc;
        }
        return null;
      };
      const chain = {
        session: () => chain,
        lean: matchDoc,
        then: (resolve, reject) => {
          matchDoc().then(resolve, reject);
        },
      };
      return chain;
    };

    const tableFindOneAndUpdate = async (filter, update) => {
      const key = String(filter._id);
      const doc = self.tables.get(key);
      if (!doc) return null;
      if (
        Object.prototype.hasOwnProperty.call(filter, "activeSettlementId") &&
        doc.activeSettlementId !== filter.activeSettlementId
      ) {
        return null;
      }
      if (update?.$set) Object.assign(doc, update.$set);
      return doc;
    };

    Table.findOneAndUpdate = function findOneAndUpdate(filter, update) {
      const chain = {
        session: () => chain,
        then: (resolve, reject) => {
          tableFindOneAndUpdate(filter, update).then(resolve, reject);
        },
      };
      return chain;
    };

    Table.findByIdAndUpdate = function findByIdAndUpdate(id, update) {
      const chain = {
        session: () => chain,
        then: (resolve, reject) => {
          tableFindOneAndUpdate({ _id: id }, update).then(resolve, reject);
        },
      };
      return chain;
    };

    GameSettlement.create = async (rows) => {
      const row = Array.isArray(rows) ? rows[0] : rows;
      const doc = {
        ...row,
        _id: oid(),
        save: async function save() {
          self.settlements.set(this.settlementId, this);
          return this;
        },
      };
      self.settlements.set(row.settlementId, doc);
      return Array.isArray(rows) ? [doc] : doc;
    };

    WalletTransaction.findOne = async () => null;

    walletLedger.assertHouseWalletReady = async () => true;
    walletLedger.withMongoTransaction = async (fn) => fn(null);
    houseWallet.ensureHouseWalletExists = async () => self.houseWallet;
    houseWallet.applyHouseDelta = async ({ delta }) => {
      self.houseWallet.lockedBalance += Number(delta) || 0;
    };

    walletLedger.recordGameBuyinLedger = async () => {};

    walletLedger.applyGameSettlementDelta = async ({
      userId,
      delta,
      rakeAmount = 0,
      tableId,
      settlementId,
    }) => {
      const w = self.wallets.get(String(userId));
      if (!w) throw new Error("WALLET_NOT_FOUND");
      const d = Number(delta) || 0;
      const rake = Number(rakeAmount) || 0;
      if (d < 0) {
        w.lockedBalance += d;
      } else {
        w.lockedBalance += d + rake;
        if (rake > 0) w.lockedBalance -= rake;
      }
      self.transactions.push({
        userId: String(userId),
        type: d >= 0 ? "game_win" : "game_loss",
        delta: d,
        rake,
        tableId: String(tableId),
        settlementId,
      });
    };

    walletLedger.applyHouseSettlementDelta = async ({ delta }) => {
      self.houseWallet.lockedBalance += Number(delta) || 0;
    };

    walletLedger.recordSettlementLedger = async () => {};

    walletLedger.setTableLockAmount = async ({ userId, tableId, amount }) => {
      self.tableLocks.set(`${userId}:${tableId}`, Number(amount) || 0);
    };

    walletLedger.releaseTableSeatToBalance = async ({ userId, seatChips }) => {
      const w = self.wallets.get(String(userId));
      if (!w) return;
      const amt = Number(seatChips) || 0;
      w.lockedBalance = Math.max(0, w.lockedBalance - amt);
      w.balance += amt;
    };
  }

  getWallet(userId) {
    return this.wallets.get(String(userId));
  }

  totalHumanLocked() {
    let sum = 0;
    for (const w of this.wallets.values()) {
      sum += w.lockedBalance || 0;
    }
    return sum;
  }

  loadGameSettlementService() {
    delete require.cache[require.resolve("../../services/gameSettlementService")];
    return require("../../services/gameSettlementService");
  }

  _clearServiceCache() {
    delete require.cache[require.resolve("../../services/gameSettlementService")];
  }

  restoreMocks() {
    const Table = require("../../models/tableModel");
    const GameSettlement = require("../../models/gameSettlementModel");
    const WalletTransaction = require("../../models/walletTransactionModel");
    const walletLedger = require("../../services/walletLedgerService");
    const houseWallet = require("../../services/houseWalletService");
    Object.assign(Table, {
      findById: this._orig.TableFindById,
      findOneAndUpdate: this._orig.TableFindOneAndUpdate,
      findByIdAndUpdate: this._orig.TableFindByIdAndUpdate,
    });
    GameSettlement.findOne = this._orig.GameSettlementFindOne;
    GameSettlement.create = this._orig.GameSettlementCreate;
    WalletTransaction.findOne = this._orig.WalletTransactionFindOne;
    Object.assign(walletLedger, {
      assertHouseWalletReady: this._orig.assertHouseWalletReady,
      withMongoTransaction: this._orig.withMongoTransaction,
      applyGameSettlementDelta: this._orig.applyGameSettlementDelta,
      recordGameBuyinLedger: this._orig.recordGameBuyinLedger,
      recordSettlementLedger: this._orig.recordSettlementLedger,
      setTableLockAmount: this._orig.setTableLockAmount,
      releaseTableSeatToBalance: this._orig.releaseTableSeatToBalance,
      applyHouseSettlementDelta: this._orig.applyHouseSettlementDelta,
    });
    houseWallet.ensureHouseWalletExists = this._orig.ensureHouseWalletExists;
    houseWallet.applyHouseDelta = this._orig.applyHouseDelta;
    this._clearServiceCache();
  }
}

module.exports = { InMemorySettlementHarness, oid };
