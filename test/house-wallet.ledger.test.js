const test = require("node:test");
const assert = require("node:assert/strict");

const HouseWalletTransaction = require("../models/houseWalletTransactionModel");
const { PokerTable } = require("../sockets/tableGame");
const { deriveMinimumBet } = require("../utils/poker/tableBettingConfig");

test("house ledger enum includes house_dev_topup used by auto-topup", () => {
  const values = HouseWalletTransaction.schema.path("type").enumValues;
  assert.ok(values.includes("house_dev_topup"));
  assert.ok(values.includes("house_settlement"));
});

function mkGame() {
  const nsp = { to() { return { emit() {} }; } };
  const g = new PokerTable(nsp, {
    _id: "house-ledger-table",
    smallBlind: 500,
    bigBlind: 1000,
    minBuyIn: 100000,
    maxBuyIn: 100000,
    buyIn: 100000,
    minimumBet: deriveMinimumBet(100000),
    capacity: 9,
    seats: [{ user: { _id: "u1", name: "Hero" }, chips: 100000, seatPosition: 4 }],
  });
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};
  return g;
}

test("settlement freeze is not cleared by chip-conservation probe", () => {
  const g = mkGame();
  g.frozen = true;
  g.frozenReason = "settlement";
  g.running = false;
  const cleared = g._tryUnfreezeFromChipProbe("bootstrap");
  assert.equal(cleared, false);
  assert.equal(g.frozen, true);
  assert.equal(g.frozenReason, "settlement");
});
