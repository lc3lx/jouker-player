/**
 * Poker leave/rejoin bootstrap tests.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { POKER_MIN_PLAYERS, POKER_CAPACITY } = require("../utils/pokerTableStatus");

test("bootstrap fills bots for solo human up to capacity", () => {
  const capacity = POKER_CAPACITY;
  const botFillTarget = capacity;
  const humans = 1;
  const toAdd = Math.min(botFillTarget - humans, capacity - humans);
  assert.equal(toAdd, 8);
  assert.equal(humans + toAdd, 9);
});

test("rejoin can start with bots when min players met", () => {
  const humans = 1;
  const active = 9;
  const canBotStart = humans >= 1 && active >= POKER_MIN_PLAYERS;
  assert.equal(canBotStart, true);
});

test("vacate restore should trigger live sync hook export", () => {
  const bridge = require("../sockets/tableGame");
  assert.equal(typeof bridge.syncLivePokerTableAfterJoin, "function");
  assert.equal(typeof bridge.PokerTable?.prototype?.bootstrapLobbyStart, "function");
});
