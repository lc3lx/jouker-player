process.env.NODE_ENV = "test";
process.env.POSEIDON_WALLET_MODE = "stub";
const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../games/poseidon/constants");
const spinEngine = require("../games/poseidon/spinEngine");
const { rngFor } = require("../tool/zeusRulesAudit");

const modes = [
  { name: "base", bonus: false, superBonus: false, weights: [10, 6, 2.5, 0.8, 0.15, 0.05, 0.02, 0.005, 0.001] },
  { name: "bonus", bonus: true, superBonus: false, weights: [12.5, 12.5, 10, 10, 5, 4, 2, 1, 0.5] },
  { name: "super", bonus: true, superBonus: true, weights: [0, 0, 0, 15, 7, 5, 3, 2, 1] },
];

for (const mode of modes) {
  test(`poseidon ${mode.name}: complete unit interval gives exact Zeus per-spin probabilities`, () => {
    const counts = new Map(), draws = 100000;
    for (let i = 0; i < draws; i++) {
      const face = spinEngine.pickMultiplierValue(() => (i + 0.5) / draws, {
        bonus: mode.bonus,
        superBonus: mode.superBonus,
      });
      counts.set(face, (counts.get(face) || 0) + 1);
    }
    for (const [i, face] of c.MULTIPLIER_VALUES.entries()) {
      assert.equal(counts.get(face) || 0, Math.round(mode.weights[i] * 1000));
    }
    assert.equal(counts.get(null), Math.round((100 - mode.weights.reduce((a, b) => a + b, 0)) * 1000));
  });

  test(`poseidon ${mode.name}: full spins and cascades retain sampled plaque/jackpot/bonus rates`, () => {
    const rng = rngFor(953);
    const counts = new Map();
    const draws = 50000;
    let appearances = 0, jackpots = 0, natural = 0;

    for (let i = 0; i < draws; i++) {
      const out = spinEngine.resolveSpin({
        rng,
        bonusMode: mode.bonus,
        superBonus: mode.superBonus,
      });
      const plaques = out.multipliers || [];
      const face = plaques.length > 0 ? plaques[0].value : null;
      counts.set(face, (counts.get(face) || 0) + 1);

      let jackpotSymbolCount = 0;
      for (const col of out.finalMatrix) {
        for (const cell of col) {
          if (cell === "jackpot") jackpotSymbolCount++;
        }
      }
      appearances += Number(jackpotSymbolCount > 0);
      jackpots += Number(jackpotSymbolCount >= 3);
      natural += Number(out.scatterCount >= 4);
    }

    const near = (observed, p) =>
      assert.ok(Math.abs(observed / draws - p) <= 6 * Math.sqrt((p * (1 - p)) / draws) + 1 / draws,
        `observed ${observed / draws} vs expected ${p}`);

    mode.weights.forEach((p, i) => near(counts.get(c.MULTIPLIER_VALUES[i]) || 0, p / 100));
    near(appearances, 0.18);
    near(jackpots, 0.0001);
    if (!mode.bonus) near(natural, 0.004);
  });
}

test("public paytable reflects active Poseidon v3 rules and per-spin rates", async () => {
  const handler = require("../controllers/slotEconomyController").forGame("poseidon");
  const id = "poseidon-v3-paytable-test";
  const read = () =>
    new Promise((resolve, reject) =>
      handler({ user: { id }, query: { betAmount: 10000 } }, { json: resolve }, reject)
    );

  const fresh = (await read()).data;
  assert.equal(fresh.economyVersion, 3);
  assert.equal(fresh.bonusRtp, null);
  assert.equal(fresh.probabilityUnit, "per_spin");
  assert.equal(fresh.jackpotAppearanceProbability, 0.18);
  assert.equal(fresh.jackpotWinProbability, 0.0001);
  assert.equal(fresh.naturalBonusProbability, 0.004);
  assert.deepEqual(fresh.multiplierProbabilities.base, [10, 6, 2.5, 0.8, 0.15, 0.05, 0.02, 0.005, 0.001]);
  assert.deepEqual(fresh.multiplierProbabilities.bonus, [12.5, 12.5, 10, 10, 5, 4, 2, 1, 0.5]);
  assert.deepEqual(fresh.multiplierProbabilities.super, [0, 0, 0, 15, 7, 5, 3, 2, 1]);
});
