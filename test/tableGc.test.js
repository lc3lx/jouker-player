const test = require("node:test");
const assert = require("node:assert/strict");

const { isBootZombieCardTable } = require("../services/tableGcService");

test("isBootZombieCardTable preserves open lobby tables without settlement lock", () => {
  const table = {
    gameType: "trix",
    status: "open",
    seats: [{ user: "u1", chips: 1000 }],
    activeSettlementId: null,
  };

  assert.equal(isBootZombieCardTable(table), false);
});

test("isBootZombieCardTable treats playing tables as zombies", () => {
  const table = {
    gameType: "tarneeb41",
    status: "playing",
    seats: [],
    activeSettlementId: null,
  };

  assert.equal(isBootZombieCardTable(table), true);
});
