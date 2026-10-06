process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createOperationRng } = require("../games/utils/operationRng");
const T = require("../tool/lib/slotProfileTemplates");
const registry = require("../games/slotProfiles/registry");
const poseidonEngine = require("../games/poseidon/spinEngine");
const zenobiaEngine = require("../games/zenobia/spinEngine");
const diceEngine = require("../games/dice/DiceEngine");
const poseidonSettlement = require("../games/poseidon/settlement");
const zenobiaSettlement = require("../games/zenobia/settlement");

const hash = (rows) => crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");

// --- the new engines are faithful parameterisations of the legacy ones ----------

test("Poseidon v4 with the v3 numbers deals exactly the v3 game", () => {
  const profile = T.legacyEquivalent("poseidon");
  for (const mode of ["base", "bonus", "super"]) {
    const v3 = [];
    const v4 = [];
    for (let i = 0; i < 600; i += 1) {
      const opts = { bonusMode: mode !== "base", superBonus: mode === "super" };
      const a = poseidonEngine.resolveSpin({ ...opts, economyVersion: 3, rng: createOperationRng(`eq-p-${mode}-${i}`) });
      const b = poseidonEngine.resolveSpin({ ...opts, economyVersion: 4, profile, rng: createOperationRng(`eq-p-${mode}-${i}`) });
      v3.push([a.initialMatrix, a.finalMatrix, a.baseWin, a.multiplierSum, a.scatterCount]);
      v4.push([b.initialMatrix, b.finalMatrix, b.baseWin, b.multiplierSum, b.scatterCount]);
    }
    assert.equal(hash(v4), hash(v3), mode);
  }
});

test("Zeus v5 with the v4 numbers deals exactly the v4 game", () => {
  const profile = T.legacyEquivalent("zeus");
  for (const mode of ["base", "bonus", "super"]) {
    const v4 = [];
    const v5 = [];
    for (let i = 0; i < 600; i += 1) {
      const opts = { isFreeSpin: mode !== "base", superBonus: mode === "super", freeSpinMultiplier: mode === "base" ? 0 : 6 };
      const a = diceEngine.spin(10000, { ...opts, economyVersion: 4, rng: createOperationRng(`eq-z-${mode}-${i}`) });
      const b = diceEngine.spin(10000, { ...opts, economyVersion: 5, profile, rng: createOperationRng(`eq-z-${mode}-${i}`) });
      v4.push([a.initialGrid, a.finalGrid, a.baseWin, a.totalWin, a.multipliers, a.scatterCount, a.jackpotSymbolCount]);
      v5.push([b.initialGrid, b.finalGrid, b.baseWin, b.totalWin, b.multipliers, b.scatterCount, b.jackpotSymbolCount]);
    }
    assert.equal(hash(v5), hash(v4), mode);
  }
});

test("unknown economy versions are rejected instead of dealt another game", () => {
  const rng = createOperationRng("unknown");
  assert.throws(() => poseidonEngine.resolveSpin({ economyVersion: 9, rng }), /UNKNOWN_POSEIDON_ECONOMY_VERSION/);
  assert.throws(() => zenobiaEngine.resolveSpin({ economyVersion: 9, rng }), /UNKNOWN_ZENOBIA_ECONOMY_VERSION/);
  assert.throws(() => diceEngine.spin(10000, { economyVersion: 9, rng }), /UNKNOWN_ZEUS_ECONOMY_VERSION/);
});

// --- Zenobia v3: published events happen only at their scheduled rate -----------

function zenobiaProfile(overrides = {}) {
  const t = T.template("zenobia");
  const q = T.powerLawFaces(t.params.plaques.values, 2);
  t.params.plaques.base = q;
  t.params.plaques.bonus = q;
  t.params.plaques.super = T.powerLawFaces(t.params.plaques.values, 1.5, t.superMinFace);
  Object.assign(t.params, overrides);
  return { ...t, id: "zenobia-test" };
}

test("Zenobia v3: three jackpots or three coins only ever come from the schedule", () => {
  const profile = zenobiaProfile({ naturalBonusProbability: 0, jackpot: { win: 0 } });
  // Organic jackpots/coins are frequent enough here that a missing cap would show.
  profile.params.jackpotWeight = { base: 6, bonus: 6, super: 6 };
  profile.params.scatterWeight = { base: 6, bonus: 6, super: 6 };
  let twoJackpots = 0;
  for (let i = 0; i < 3000; i += 1) {
    const s = zenobiaEngine.resolveSpin({ economyVersion: 3, profile, rng: createOperationRng(`zc-${i}`) });
    assert.ok(s.jackpotCount <= 2, "organic jackpots are capped at two");
    assert.ok(s.scatterCount <= 2, "organic base-game coins are capped at two");
    if (s.jackpotCount === 2) twoJackpots += 1;
  }
  assert.ok(twoJackpots > 0, "the cap is exercised");
  const scheduled = zenobiaProfile({ naturalBonusProbability: 1, jackpot: { win: 1 } });
  const s = zenobiaEngine.resolveSpin({ economyVersion: 3, profile: scheduled, rng: createOperationRng("zs") });
  assert.equal(s.jackpotCount, 3);
  assert.equal(s.scatterCount, 3);
});

test("Zenobia v3 super plaques never deal below the super minimum", () => {
  const profile = zenobiaProfile();
  for (let i = 0; i < 400; i += 1) {
    const s = zenobiaEngine.resolveSpin({ economyVersion: 3, profile, bonusMode: true, superBonus: true, rng: createOperationRng(`zsup-${i}`) });
    for (const m of s.multipliers) assert.ok(m.value >= 30);
  }
});

// --- settlement rules of the new versions ----------------------------------------

const RULES = T.rules("poseidon");

test("v4+ rounds stop at the cumulative max-win cap", () => {
  const spin = { baseWin: 10, multiplierSum: 100, scatterCount: 3 };
  const session = { bonusMultiplier: 0, roundWonX: 4500, freeSpinsRemaining: 6 };
  const r = poseidonSettlement.settleSpin({ spin, economyVersion: 4, rules: RULES, session });
  assert.equal(r.winX, 500);
  assert.equal(r.capReached, true);
  assert.equal(r.award, null, "no retrigger once the round is capped");
  const legacy = poseidonSettlement.settleSpin({ spin, economyVersion: 3, session });
  assert.equal(legacy.winX, 1000, "legacy sessions keep the per-spin cap only");
});

test("retriggers never push a round past the free-spin ceiling", () => {
  const spin = { baseWin: 0, multiplierSum: 0, scatterCount: 3 };
  const r = poseidonSettlement.settleSpin({ spin, economyVersion: 4, rules: RULES, session: { bonusMultiplier: 0, roundWonX: 0, freeSpinsRemaining: 48 } });
  assert.deepEqual(r.award, { type: "retrigger", spins: 2 });
});

test("Zenobia v3 bank needs a fresh plaque; v2 sessions keep the rule they were sold", () => {
  const session = { bonusMultiplier: 50, roundWonX: 0, freeSpinsRemaining: 5 };
  const spin = { baseWin: 2, multiplierSum: 0, scatterCount: 0 };
  const v3 = zenobiaSettlement.settleSpin({ spin, economyVersion: 3, rules: T.rules("zenobia"), session });
  assert.equal(v3.applied, 1);
  assert.equal(v3.nextCarried, 50);
  const v2 = zenobiaSettlement.settleSpin({ spin, economyVersion: 2, session });
  assert.equal(v2.applied, 50);
  const fresh = zenobiaSettlement.settleSpin({ spin: { ...spin, multiplierSum: 20 }, economyVersion: 3, rules: T.rules("zenobia"), session });
  assert.equal(fresh.applied, 70);
  assert.equal(fresh.nextCarried, 70);
});

// --- registry -----------------------------------------------------------------------

test("the registry rejects malformed or money-losing profiles", () => {
  const good = registry.listProfiles("poseidon")[0];
  if (!good) return; // profiles not generated yet
  const broken = (patch) => ({ ...structuredClone(good), ...patch });
  assert.throws(() => registry.validateProfile(broken({ digest: undefined })), /digest/);
  assert.throws(() => registry.validateProfile(broken({ buy: { ...good.buy, standardCost: good.buy.standardEv - 1 } })), /more than it costs/);
  const tooLikely = structuredClone(good);
  tooLikely.params.plaques.base = tooLikely.params.plaques.base.map(() => 50);
  assert.throws(() => registry.validateProfile(tooLikely), /exceed 100%/);
});

for (const game of registry.GAMES) {
  test(`${game}: shipped profiles are verified, priced below EV parity and hit their target`, () => {
    const list = registry.listProfiles(game);
    if (list.length === 0) return; // not calibrated yet
    const report = registry.verifyAll();
    assert.ok(registry.defaultProfileId(game), "a 94% default exists");
    for (const p of list) {
      assert.equal(report[p.id].ok, true, `${p.id} digest`);
      assert.ok(Math.abs(p.measured.rtp - p.targetRtp) < 0.002, `${p.id} expected RTP`);
      assert.ok(Math.abs(p.measured.rtpMonteCarlo - p.targetRtp) <= 4 * p.measured.rtpMonteCarloCi95 / 1.96 + 0.002, `${p.id} Monte-Carlo RTP`);
      assert.ok(p.measured.buy.standardRtp < 1 && p.measured.buy.superRtp < 1, `${p.id} buys`);
      assert.ok(Math.abs(p.measured.buy.standardRtp - p.targetRtp) < 0.003, `${p.id} standard buy at target`);
      assert.ok(Math.abs(p.measured.buy.superRtp - p.targetRtp) < 0.003, `${p.id} super buy at target`);
    }
  });
}
