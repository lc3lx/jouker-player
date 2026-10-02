process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const e = require("../games/dice/DiceEngine");
const { rngFor, session } = require("../tool/zeusRulesAudit");
const expected = { 0: [8000, 1000], 1: [8000, 1000], 2: [8000, 1000], 3: [8000, 1000],
  6: [11000, 2000], 4: [11000, 3000], 5: [14000, 3500], 7: [20000, 5000] };

test("each symbol pays the requested formula from 8 through 30, at multiple stakes", () => {
  for (const [symbol, [start, extra]] of Object.entries(expected)) {
    assert.equal(e.symbolMultiplier(symbol, 7), 0);
    for (const bet of [10000, 50000, 1000000000]) for (let count = 8; count <= 30; count++) {
      const other = Array.from({ length: 8 }, (_, i) => i).filter(i => i !== Number(symbol));
      const cells = Array.from({ length: 30 }, (_, i) => i < count ? Number(symbol) : other[i % other.length]);
      const grid = Array.from({ length: 6 }, (_, col) => cells.slice(col * 5, col * 5 + 5));
      assert.equal(e.calculateWins(grid, bet).totalWin, (start + (count - 8) * extra) * bet / 10000);
    }
  }
});

const modes = [
  { name: "base", bonus: false, superBonus: false, weights: [10, 6, 2.5, 0.8, 0.15, 0.05, 0.02, 0.005, 0.001] },
  { name: "bonus", bonus: true, superBonus: false, weights: [14, 9, 5, 1.8, 0.7, 0.3, 0.12, 0.04, 0.01] },
  { name: "super", bonus: true, superBonus: true, weights: [0, 0, 0, 15, 7, 5, 3, 2, 1] },
];
for (const mode of modes) {
  test(`${mode.name}: complete unit interval gives the exact specified per-spin probabilities`, () => {
    const counts = new Map(), draws = 100000;
    for (let i = 0; i < draws; i++) {
      const face = e.pickMultiplierValue(() => (i + 0.5) / draws, "high", { ...mode, bigAlready: true });
      counts.set(face, (counts.get(face) || 0) + 1);
    }
    for (const [i, face] of e.MULTIPLIER_VALUES.entries()) assert.equal(counts.get(face) || 0, Math.round(mode.weights[i] * 1000));
    assert.equal(counts.get(null), Math.round((100 - mode.weights.reduce((a,b) => a+b,0)) * 1000));
  });
  test(`${mode.name}: full spins and cascades retain the sampled plaque/jackpot rates`, () => {
    const rng = rngFor(841), counts = new Map();
    const draws = 50000;
    let appearances = 0, jackpots = 0, natural = 0;
    for (let i = 0; i < draws; i++) {
      const out = e.spin(10000, { rng, isFreeSpin: mode.bonus, superBonus: mode.superBonus });
      const face = out.multipliers.collected || null;
      counts.set(face, (counts.get(face) || 0) + 1);
      appearances += Number(out.jackpotSymbolCount > 0);
      jackpots += Number(out.jackpotTriggered);
      natural += Number(out.freeSpinsAwarded > 0);
      for (const grid of [out.initialGrid, out.finalGrid, ...out.cascadeSteps.map(s => s.afterGrid)]) {
        const plaques = grid.flat().filter(s => s >= e.MULTIPLIER && s < e.JACKPOT);
        assert.equal(plaques.length, face === null ? 0 : 1);
        if (face !== null) assert.equal(e.MULTIPLIER_VALUES[plaques[0] - e.MULTIPLIER], face);
        assert.equal(e.countJackpotSymbols(grid), out.jackpotSymbolCount);
      }
      assert.equal(out.totalWin, Math.min(Math.round(out.baseWin * out.multipliers.applied * 100) / 100, out.maxWin));
    }
    const near = (observed, p) => assert.ok(Math.abs(observed / draws - p) <= 6 * Math.sqrt(p * (1-p) / draws) + 1/draws);
    mode.weights.forEach((p,i) => near(counts.get(e.MULTIPLIER_VALUES[i]) || 0, p / 100));
    near(appearances, .18); near(jackpots, .0001);
    if (!mode.bonus) near(natural, .004); else assert.equal(natural, 0);
  });
}

test("stake, bank, player hints and old payScale cannot change the new rules", () => {
  const options = { serverSeed: "new-fixed-rules", clientSeed: "client", nonce: "1", isFreeSpin: true };
  for (let n = 0; n < 100; n++) {
    const first = e.spin(10000, { ...options, nonce: n });
    const modified = e.spin(1000000, { ...options, nonce: n, freeSpinMultiplier: 999, payScale: .001, volatility: "high" });
    assert.deepEqual(first.initialGrid, modified.initialGrid);
    assert.deepEqual(first.finalGrid, modified.finalGrid);
    assert.equal(modified.baseWin, first.baseWin * 100);
  }
});

test("v1 and v2 bonus sessions keep exact legacy outcomes", () => {
  for (const version of [1,2]) for (const superBonus of [false,true]) {
    const options = { serverSeed: "legacy", clientSeed: "client", nonce: 19, isFreeSpin: true, superBonus, freeSpinMultiplier: 115 };
    assert.deepEqual(e.spin(10000, { ...options, economyVersion: version }), require(`../games/dice/DiceEngine.v${version}`).spin(10000, options));
  }
});

test("new free sessions are standard bonus v3 and audits complete the actual settlement", () => {
  const { stageSpinSession } = require("../games/dice/kingArthSettlement");
  const staged = stageSpinSession(null, { economyVersion: 3, scatterCount: 4, capped: false, maxWin: 50000000 }, 10000, 10000);
  assert.equal(staged.next.economyVersion, 3);
  assert.equal(staged.next.superBonus, false);
  for (const mode of ["base","bonus","super"]) {
    const result = session({ mode, bet: 10000, version: 3, rng: rngFor(713), jackpotRng: rngFor(512) });
    assert.ok(Number.isSafeInteger(result.payout));
    assert.ok(result.spins >= (mode === "base" || result.capped ? 1 : 10));
    if (result.capped && mode !== "base") assert.equal(result.payout, 10000 * e.MAX_WIN_MULTIPLIER);
  }
});

test("the public paytable reflects the active version, fixed payouts and per-spin rates", async () => {
  const states = require("../games/dice/kingArthRoundState");
  const handler = require("../controllers/slotEconomyController").forGame("zeus");
  const id = "zeus-v3-paytable-test";
  const read = () => new Promise((resolve, reject) => handler({ user: { id }, query: { betAmount: 10000 } }, { json: resolve }, reject));
  try {
    const fresh = (await read()).data;
    assert.equal(fresh.economyVersion, 3);
    assert.equal(fresh.bonusRtp, null);
    assert.equal(fresh.probabilityUnit, "per_spin");
    assert.deepEqual(fresh.payoutRows.find(row => row.symbol === 6).values, [1.1, .2]);
    assert.deepEqual(fresh.multiplierProbabilities.super, [0,0,0,15,7,5,3,2,1]);
    await states.startFreeSpinSession(id, "king-arth", { lockedBaseBet: 10000, economyVersion: 2 });
    const old = (await read()).data;
    assert.equal(old.economyVersion, 2);
    assert.deepEqual(old.payoutColumns, ["8-9","10-11","12+"]);
    assert.equal(old.payoutRows[0].values.length, 3);
    assert.equal(old.multiplierProbabilities, undefined);
  } finally { await states.deleteFreeSpinSession(id, "king-arth"); }
});
