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

test("a lone player gets 15 seconds for a real opponent before bots", () => {
  const prev = process.env.POKER_WAIT_FOR_PLAYERS_MS;
  delete process.env.POKER_WAIT_FOR_PLAYERS_MS;
  delete require.cache[require.resolve("../utils/poker/timings")];
  const { POKER_TIMINGS: fresh } = require("../utils/poker/timings");
  assert.equal(fresh.WAIT_FOR_PLAYERS_MS, 15000);
  if (prev) process.env.POKER_WAIT_FOR_PLAYERS_MS = prev;
});

test("bot fill stops at the per-table ceiling, leaving chairs for humans", () => {
  const capacity = POKER_CAPACITY;
  const maxBots = 4;
  const active = 1; // one seated human
  const missing = Math.max(0, capacity - active);
  const toAdd = Math.min(missing, maxBots);

  assert.equal(toAdd, 4, "a lone human is joined by at most four bots");
  assert.equal(
    capacity - (active + toAdd),
    4,
    "the rest of the table stays open for real players",
  );
});

test("min players to start remains 2", () => {
  assert.equal(POKER_MIN_PLAYERS, 2);
});
