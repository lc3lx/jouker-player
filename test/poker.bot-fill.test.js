/**
 * Poker bot fill + lobby state tests.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { POKER_CAPACITY, POKER_MIN_PLAYERS } = require("../utils/pokerTableStatus");
const { POKER_TIMINGS } = require("../utils/poker/timings");

test("POKER_CAPACITY is 9 seats", () => {
  assert.equal(POKER_CAPACITY, 9);
});

test("solo wait window defaults to 8 seconds", () => {
  const prev = process.env.POKER_WAIT_FOR_PLAYERS_MS;
  delete process.env.POKER_WAIT_FOR_PLAYERS_MS;
  delete require.cache[require.resolve("../utils/poker/timings")];
  const { POKER_TIMINGS: fresh } = require("../utils/poker/timings");
  assert.equal(fresh.WAIT_FOR_PLAYERS_MS, 8000);
  if (prev) process.env.POKER_WAIT_FOR_PLAYERS_MS = prev;
});

test("bot fill math: 1 human fills 8 bots to reach 9", () => {
  const capacity = POKER_CAPACITY;
  const botFillTarget = capacity;
  const active = 1;
  const missing = Math.max(0, botFillTarget - active);
  assert.equal(missing, 8);
  assert.equal(active + missing, 9);
});

test("min players to start remains 2", () => {
  assert.equal(POKER_MIN_PLAYERS, 2);
});
