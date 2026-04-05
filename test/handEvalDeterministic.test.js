const test = require("node:test");
const assert = require("node:assert/strict");
const { compareHands7 } = require("../utils/poker/handEval");

test("same board: pocket aces beat pocket kings (deterministic)", () => {
  const board = ["2c", "7h", "9s", "Jh", "3d"];
  const aa = ["As", "Ad", ...board];
  const kk = ["Ks", "Kd", ...board];
  assert(compareHands7(aa, kk) > 0);
});

test("identical holdings tie", () => {
  const cards = ["As", "Ad", "2c", "7h", "9s", "Jh", "3d"];
  assert.equal(compareHands7(cards, [...cards]), 0);
});
