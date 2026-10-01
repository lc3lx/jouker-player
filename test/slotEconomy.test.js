process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const economy = require("../games/utils/slotEconomy");
const { rngFor } = require("../tool/slotEconomyAudit");
const operation = require("../games/utils/slotOperation");

test("specified faces are exact normalized probabilities, independent of stacking or bet", () => {
  for (const folder of ["poseidon", "zenobia", "dice"]) {
    const c = require(`../games/${folder}/${folder === "dice" ? "DiceEngine" : "constants"}`);
    for (const weights of [c.BASE_MULTIPLIER_WEIGHTS, c.BONUS_MULTIPLIER_WEIGHTS]) {
      assert.ok(Math.abs(weights.reduce((a,b) => a+b,0) - 100) < 1e-10);
      for (const [face, percent] of Object.entries(economy.HIGH_PROBABILITIES)) assert.equal(weights[c.MULTIPLIER_VALUES.indexOf(Number(face))], percent);
    }
    const engine = require(`../games/${folder}/${folder === "dice" ? "DiceEngine" : "spinEngine"}`);
    const counts = new Map(), rng = rngFor(817), draws = 500000;
    for (let n = 0; n < draws; n++) {
      const opts = { bonus: true, superBonus: true, bigAlready: true };
      const face = folder === "dice" ? engine.pickMultiplierValue(rng, "medium", opts) : engine.pickMultiplierValue(rng, opts);
      assert.ok(face === null || face >= 20);
      counts.set(face, (counts.get(face) || 0) + 1);
    }
    for (let i = 0; i < economy.SUPER_VALUES.length; i++) {
      const p = economy.SUPER_WEIGHTS[i] / 100, observed = (counts.get(economy.SUPER_VALUES[i]) || 0) / draws;
      assert.ok(Math.abs(observed - p) <= 6 * Math.sqrt(p * (1-p) / draws) + 1 / draws);
    }
  }
});

test("bonus tree probabilities and all purchase prices match policy", () => {
  const tree = require("../games/goldenTree/constants");
  assert.deepEqual(tree.BONUS_WILD_MULTIPLIER_WEIGHTS, [[1,84],[2,10],[3,5],[5,1]]);
  assert.equal(tree.BUY_BONUS_COST, 200);
  for (const folder of ["poseidon", "zenobia", "dice"]) {
    const c = require(`../games/${folder}/${folder === "dice" ? "DiceEngine" : "constants"}`);
    assert.equal(c.SUPER_BUY_BONUS_COST || c.SUPER_BUY_COST_MULT, 10 * (c.BUY_BONUS_COST || c.BUY_COST_MULT));
  }
});

for (const folder of ["poseidon", "zenobia", "goldenTree"]) {
  const service = require(`../games/${folder}/${folder}Service`);
  const manager = require(`../games/${folder}/roundManager`);
  const wallet = require(`../games/${folder}/${folder}WalletAdapter`);
  const buy = (user, requestId) => folder === "goldenTree" ? service.executeBuyBonus(user, "Triple", 10000, { requestId }) : service.executeBuyBonus(user, 10000, { requestId });

  test(`${folder}: concurrent/repeated requests debit once and consume one bonus spin`, async () => {
    operation.clearForTests(); manager.clearAllForTests(); wallet.clearStubForTests();
    const user = `${folder}-idempotent`; wallet.seedStubBalance(user, 1e8);
    const [first, again] = await Promise.all([buy(user, "purchase_00001"), buy(user, "purchase_00001")]);
    assert.deepEqual(first, again);
    assert.equal(first.balance, 1e8 - first.cost);
    assert.equal(manager.getBonusSession(user).economyVersion, 2);
    const remaining = manager.getBonusSession(user).freeSpinsRemaining;
    const [spin, repeated] = await Promise.all([service.executeSpin(user, 10000, { requestId: "spin_00000001" }), service.executeSpin(user, 10000, { requestId: "spin_00000001" })]);
    assert.deepEqual(spin, repeated);
    assert.equal(await wallet.getBalance(user), first.balance + spin.totalWin);
    assert.equal(manager.getBonusSession(user).freeSpinsRemaining, remaining - 1 + (spin.freeSpinsAwarded || 0));
    await assert.rejects(service.executeSpin(user, 20000, { requestId: "spin_00000001" }), /different input/);
  });

  test(`${folder}: failed settlement preserves entitlement, bank and balance`, async () => {
    operation.clearForTests(); manager.clearAllForTests(); wallet.clearStubForTests();
    const user = `${folder}-failure`; wallet.seedStubBalance(user, 1e8);
    await buy(user, "purchase_00002");
    const previous = structuredClone(manager.getBonusSession(user)), balance = await wallet.getBalance(user), settle = wallet.atomicSpinWallet;
    wallet.atomicSpinWallet = async () => { throw new Error("injected settlement failure"); };
    try { await assert.rejects(service.executeSpin(user, 10000, { requestId: "spin_00000002" }), /injected settlement/); }
    finally { wallet.atomicSpinWallet = settle; }
    assert.deepEqual(manager.getBonusSession(user), previous);
    assert.equal(await wallet.getBalance(user), balance);
    const res = await service.executeSpin(user, 10000, { requestId: "spin_00000002" });
    assert.equal(res.balance, balance + res.totalWin);
  });
}

test("Zenobia applies the entire bank and never changes it on a losing/no-plaque spin", async () => {
  const service = require("../games/zenobia/zenobiaService"), engine = require("../games/zenobia/spinEngine"), manager = require("../games/zenobia/roundManager"), wallet = require("../games/zenobia/zenobiaWalletAdapter");
  const user = "zenobia-bank-exact"; wallet.seedStubBalance(user, 1e12); manager.clearAllForTests();
  manager.createBonusSession(user, { betAmount: 1000000000 }); manager.setBonusMultiplier(user, 50);
  const original = engine.resolveSpin;
  let baseWin = 2, plaqueSum = 20;
  engine.resolveSpin = () => ({ initialMatrix: [], finalMatrix: [], steps: [], baseWin, multiplierSum: plaqueSum, multipliers: plaqueSum ? [{ value: plaqueSum }] : [], scatters: [], scatterCount: 0 });
  try {
    const first = await service.executeSpin(user, 10000);
    assert.equal(first.appliedMultiplier, 70); assert.equal(first.bonusMultiplier, 70); assert.equal(first.totalWin, 140 * 1000000000);
    plaqueSum = 0;
    const ordinary = await service.executeSpin(user, 10000);
    assert.equal(ordinary.appliedMultiplier, 1); assert.equal(ordinary.bonusMultiplier, 70);
    baseWin = 0; plaqueSum = 1000;
    const lost = await service.executeSpin(user, 10000);
    assert.equal(lost.totalWin, 0); assert.equal(lost.bonusMultiplier, 70);
  } finally { engine.resolveSpin = original; }
});

test("legacy sessions retain their original engine while new sessions use v2", () => {
  const engine = require("../games/dice/DiceEngine"), old = require("../games/dice/DiceEngine.v1");
  const opts = { serverSeed: "legacy-session", clientSeed: "test", nonce: "7", isFreeSpin: true, superBonus: true };
  assert.deepEqual(engine.spin(10000, { ...opts, economyVersion: 1 }), old.spin(10000, opts));
  for (const game of ["poseidon", "zenobia"]) {
    const current = require(`../games/${game}/spinEngine`), legacy = require(`../games/${game}/spinEngine.v1`);
    assert.deepEqual(current.resolveSpin({ rng: rngFor(1), bonusMode: true, economyVersion: 1 }), legacy.resolveSpin({ rng: rngFor(1), bonusMode: true }));
  }
});

test("Zeus stages cumulative cap and retriggers without mutating an unpaid session", () => {
  const { stageSpinSession } = require("../games/dice/kingArthSettlement");
  const before = { remaining: 2, totalMultiplier: 50, roundWon: 49990000, roundCap: 50000000, economyVersion: 1 };
  const snapshot = structuredClone(before);
  const capped = stageSpinSession(before, { capped: false, scatterCount: 3, multipliers: { freeSpinTotal: 70 } }, 20000, 10000);
  assert.equal(capped.payout, 10000); assert.equal(capped.next, null); assert.equal(capped.awarded, 0);
  assert.deepEqual(before, snapshot);
  const ante = stageSpinSession(null, { doubleChance: true, maxWin: 62500000, scatterCount: 4, multipliers: {} }, 500, 10000);
  assert.equal(ante.next.lockedDoubleChance, true);
  assert.equal(ante.next.roundCap, 62500000);
});
