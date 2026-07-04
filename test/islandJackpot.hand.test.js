const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyIslandHand,
  evaluateIslandHand,
  compareHandTypes,
} = require("../utils/islandJackpotHand");

test("classifyIslandHand detects royal flush", () => {
  const rank = { cat: 8, tiebreak: [14, 13, 12, 11, 10] };
  assert.equal(classifyIslandHand(rank), "royalFlush");
});

test("classifyIslandHand detects straight flush", () => {
  const rank = { cat: 8, tiebreak: [9, 8, 7, 6, 5] };
  assert.equal(classifyIslandHand(rank), "straightFlush");
});

test("classifyIslandHand detects four of a kind", () => {
  const rank = { cat: 7, tiebreak: [14, 14, 14, 14, 9] };
  assert.equal(classifyIslandHand(rank), "fourOfAKind");
});

test("classifyIslandHand rejects full house", () => {
  const rank = { cat: 6, tiebreak: [14, 14, 14, 9, 9] };
  assert.equal(classifyIslandHand(rank), null);
});

test("evaluateIslandHand from cards", () => {
  const hole = ["Ah", "Kh"];
  const community = ["Qh", "Jh", "Th", "2d", "3c"];
  const result = evaluateIslandHand(hole, community);
  assert.ok(result);
  assert.equal(result.handType, "royalFlush");
});

test("compareHandTypes ranks royal above straight flush", () => {
  assert.ok(compareHandTypes("royalFlush", "straightFlush") > 0);
  assert.ok(compareHandTypes("straightFlush", "fourOfAKind") > 0);
});
