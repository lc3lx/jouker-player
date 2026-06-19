const { test } = require("node:test");
const assert = require("node:assert/strict");
const { POKER_TIMINGS } = require("../utils/poker/timings");
const {
  findActiveVacatingEntry,
  isVacateActive,
} = require("../services/pokerVacateService");

test("VACATE_WINDOW_MS defaults to 30 seconds", () => {
  assert.equal(POKER_TIMINGS.VACATE_WINDOW_MS, 30000);
});

test("isVacateActive respects vacateUntil", () => {
  const future = new Date(Date.now() + 5000);
  const past = new Date(Date.now() - 1000);
  assert.equal(isVacateActive({ vacateUntil: future }), true);
  assert.equal(isVacateActive({ vacateUntil: past }), false);
});

test("findActiveVacatingEntry matches user", () => {
  const table = {
    vacatingPlayers: [
      { user: "u1", chips: 5000, vacateUntil: new Date(Date.now() + 10000) },
      { user: "u2", chips: 3000, vacateUntil: new Date(Date.now() - 1000) },
    ],
  };
  assert.equal(findActiveVacatingEntry(table, "u1")?.chips, 5000);
  assert.equal(findActiveVacatingEntry(table, "u2"), null);
});

console.log("poker.vacate.test.js: all tests registered");
