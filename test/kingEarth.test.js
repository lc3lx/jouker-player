/** King Earth uses the Poseidon-style 7+ tumble rules and supplied art IDs. */
const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../games/dice/DiceEngine");
const roundState = require("../games/dice/kingArthRoundState");

test("uses the eight supplied symbols and multiplier plaque values", () => {
  assert.equal(engine.REGULAR_SYMBOLS, 8);
  assert.deepEqual(engine.MULTIPLIER_VALUES, [2, 5, 10, 20, 50, 100, 200, 500, 1000]);
  assert.equal(engine.FREE_SPINS_AWARD, 5);
  assert.equal(engine.FREE_SPINS_BOUGHT, 10);
  assert.equal(engine.BUY_COST_MULT, 30);
  assert.equal(engine.MAX_WIN_MULTIPLIER, 5000);
});

test("pays any 7+ matching symbols with Poseidon bands", () => {
  assert.equal(engine.symbolMultiplier(0, 6), 0);
  assert.equal(engine.symbolMultiplier(0, 7), 1);
  assert.equal(engine.symbolMultiplier(0, 10), 1.15);
  assert.equal(engine.symbolMultiplier(7, 12), 5);
});

test("seeded spins are deterministic and only yield known symbol IDs", () => {
  const options = { serverSeed: "srv", clientSeed: "client", nonce: "42", isFreeSpin: true };
  const first = engine.spin(1, options);
  const second = engine.spin(1, options);
  assert.deepEqual(first, second);
  assert.ok(first.finalGrid.flat().every((symbol) => symbol >= 0 && symbol < engine.SYMBOL_COUNT));
  assert.ok(first.totalWin <= first.maxWin);
});

test("base and bonus multiplier caps match Poseidon", () => {
  assert.equal(engine.appliedMultiplierFor(1000, false), 2);
  assert.equal(engine.appliedMultiplierFor(1000, true), 10);
});

test("multiplier landing rates use Poseidon's base and bonus ratios", () => {
  const regularMass = engine.BASE_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  const baseChance = 0.35 / (regularMass + 0.35);
  const bonusChance = 1.2 / (regularMass + 1.2);
  assert.ok(Math.abs(baseChance - 0.35 / 76.6) < 1e-10);
  assert.ok(Math.abs(bonusChance - 1.2 / 77.45) < 1e-10);
  assert.deepEqual(engine.BASE_MULTIPLIER_WEIGHTS, [55, 18, 12, 6.5, 3.8, 2.4, 1.2, 0.7, 0.4]);
  assert.deepEqual(engine.BONUS_MULTIPLIER_WEIGHTS, [36, 16, 14, 11, 8, 6, 4, 3, 2]);
});

test("natural free spins start with five spins", async () => {
  const uid = `king-earth-${Date.now()}`;
  try {
    const session = await roundState.awardFreeSpins(uid, "test", 4, 1, false);
    assert.equal(session.remaining, 5);
  } finally {
    await roundState.deleteFreeSpinSession(uid, "test");
  }
});
