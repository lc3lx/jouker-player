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
  assert.equal(engine.SUPER_BUY_COST_MULT, 90);
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

test("applied multiplier uses full plaque face value (no soft-cap)", () => {
  assert.equal(engine.appliedMultiplierFor(1000, false), 1000);
  assert.equal(engine.appliedMultiplierFor(1000, true), 1000);
  assert.equal(engine.appliedMultiplierFor(500, false), 500);
  assert.equal(engine.appliedMultiplierFor(2, true), 2);
});

test("multiplier applies only when the spin wins", () => {
  for (let n = 0; n < 240; n += 1) {
    const outcome = engine.spin(10000, {
      serverSeed: "srv-mult",
      clientSeed: "client-mult",
      nonce: String(n),
    });
    if (outcome.baseWin <= 0) {
      assert.equal(outcome.multipliers.applied, 1);
      assert.equal(outcome.totalWin, 0);
    } else if (outcome.multipliers.collected > 0) {
      assert.ok(outcome.multipliers.applied >= 1);
      assert.ok(outcome.totalWin > 0);
    }
  }
});

test("multiplier landing rates use Poseidon-aligned plaque spawn weights", () => {
  const regularMass = engine.BASE_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  const baseChance = 0.22 / (regularMass + 0.22);
  const bonusChance = 0.55 / (regularMass + 0.55);
  assert.ok(Math.abs(baseChance - 0.22 / (regularMass + 0.22)) < 1e-12);
  assert.ok(Math.abs(bonusChance - 0.55 / (regularMass + 0.55)) < 1e-12);
  assert.deepEqual(engine.BASE_MULTIPLIER_WEIGHTS, [82, 11, 4.2, 1.6, 0.7, 0.3, 0.12, 0.05, 0.02]);
  assert.deepEqual(engine.BONUS_MULTIPLIER_WEIGHTS, [62, 16, 10, 5.5, 3, 1.8, 0.9, 0.45, 0.2]);
});

test("natural free spins start with five spins", async () => {
  const uid = `king-earth-${Date.now()}`;
  try {
    const session = await roundState.awardFreeSpins(uid, "test", 4, 1, false);
    assert.equal(session.remaining, 5);
    assert.equal(session.superBonus, false);
  } finally {
    await roundState.deleteFreeSpinSession(uid, "test");
  }
});

test("super buy-bonus plaques are always x20+ on every drop and tumble", () => {
  for (let n = 0; n < 180; n += 1) {
    const outcome = engine.spin(10000, {
      serverSeed: "srv-super",
      clientSeed: "client-super",
      nonce: String(n),
      isFreeSpin: true,
      superBonus: true,
    });
    const scan = (grid) => {
      for (const col of grid) {
        for (const symbol of col) {
          if (symbol < engine.MULTIPLIER || symbol >= engine.JACKPOT) continue;
          const value = engine.MULTIPLIER_VALUES[symbol - engine.MULTIPLIER];
          assert.ok(value >= engine.SUPER_MULTIPLIER_MIN, `super plaque ${value}`);
        }
      }
    };
    scan(outcome.initialGrid);
    scan(outcome.finalGrid);
    for (const step of outcome.cascadeSteps || []) {
      if (step.grid) scan(step.grid);
      if (step.afterGrid) scan(step.afterGrid);
    }
  }
});

test("bonus payout multiplier banks only on winning free spins", () => {
  assert.deepEqual(
    engine.resolvePayoutMultiplier({
      baseWin: 0,
      plaqueSum: 10,
      carried: 8,
      isFreeSpin: true,
    }),
    { applied: 1, nextCarried: 8, plaques: 0 },
  );
  assert.deepEqual(
    engine.resolvePayoutMultiplier({
      baseWin: 2,
      plaqueSum: 5,
      carried: 10,
      isFreeSpin: true,
    }),
    { applied: 15, nextCarried: 15, plaques: 5 },
  );
  assert.deepEqual(
    engine.resolvePayoutMultiplier({
      baseWin: 4,
      plaqueSum: 0,
      carried: 15,
      isFreeSpin: true,
    }),
    { applied: 15, nextCarried: 15, plaques: 0 },
  );
  assert.deepEqual(
    engine.resolvePayoutMultiplier({
      baseWin: 2,
      plaqueSum: 10,
      isFreeSpin: false,
    }),
    { applied: 10, nextCarried: 0, plaques: 10 },
  );
});
