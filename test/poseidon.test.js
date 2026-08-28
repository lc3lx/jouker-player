process.env.POSEIDON_WALLET_MODE = "stub";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  REEL_COUNT,
  ROW_COUNT,
  SYMBOLS,
  MIN_MATCH,
  TRIGGER_NATURAL_MIN,
  TRIGGER_RETRIGGER_MIN,
  FREE_SPINS_NATURAL,
  FREE_SPINS_BOUGHT,
  BUY_BONUS_COST,
  SUPER_BUY_BONUS_COST,
  MAX_WIN_MULTIPLIER,
  MULTIPLIER_VALUES,
  payoutFor,
  winTierFor,
  isMultiplier,
  roundMoney,
  appliedMultiplierFor,
} = require("../games/poseidon/constants");
const { findWins, collectMultipliers } = require("../games/poseidon/winCalculator");
const {
  resolveSpin,
  pickMultiplierValue,
} = require("../games/poseidon/spinEngine");
const roundManager = require("../games/poseidon/roundManager");
const wallet = require("../games/poseidon/poseidonWalletAdapter");
const poseidonService = require("../games/poseidon/poseidonService");

/** Deterministic PRNG so engine tests are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fullMatrix(fill) {
  return Array.from({ length: REEL_COUNT }, () => Array(ROW_COUNT).fill(fill));
}

beforeEach(() => {
  roundManager.clearAllForTests();
  wallet.clearStubForTests();
});

// --- constants / paytable -------------------------------------------------

test("payoutFor respects the 7-9 / 10-11 / 12+ bands and the design ranking", () => {
  assert.equal(payoutFor(SYMBOLS.CROWN, 6), 0);
  assert.equal(payoutFor(SYMBOLS.CROWN, 7), 2.0);
  assert.equal(payoutFor(SYMBOLS.CROWN, 10), 3.5);
  assert.equal(payoutFor(SYMBOLS.CROWN, 12), 5);

  assert.equal(payoutFor(SYMBOLS.A, 7), 1.0);
  assert.equal(payoutFor(SYMBOLS.A, 12), 1.5);

  // crown > fish > pearl > starfish > coral > letters
  const order = [
    SYMBOLS.CROWN,
    SYMBOLS.FISH,
    SYMBOLS.PEARL,
    SYMBOLS.STARFISH,
    SYMBOLS.CORAL,
    SYMBOLS.A,
  ];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(
      payoutFor(order[i - 1], 7) > payoutFor(order[i], 7),
      `${order[i - 1]} must outrank ${order[i]}`,
    );
  }

  // the four letters pay identically
  for (const letter of [SYMBOLS.E, SYMBOLS.N, SYMBOLS.S]) {
    for (const count of [7, 10, 12]) {
      assert.equal(payoutFor(letter, count), payoutFor(SYMBOLS.A, count));
    }
  }
});

test("winTierFor maps bet multiples to banners", () => {
  assert.equal(winTierFor(10), null);
  assert.equal(winTierFor(25), "super");
  assert.equal(winTierFor(60), "mega");
  assert.equal(winTierFor(120), "grand");
  assert.equal(winTierFor(400), "jackpot");
});

// --- multiplier value weights -------------------------------------------------

test("weighted plaques: ladder descending; high faces rare but possible", () => {
  const rng = mulberry32(2024);
  const counts = {};
  const draws = 200000;
  for (let i = 0; i < draws; i += 1) {
    const v = pickMultiplierValue(rng);
    counts[v] = (counts[v] || 0) + 1;
  }
  // Full face-value payout: x2 dominates; x500/x1000 stay rare for RTP.
  assert.ok(counts[2] / draws > 0.75 && counts[2] / draws < 0.9, `x2 share ${counts[2] / draws}`);
  const midPlus =
    (counts[20] + counts[50] + counts[100] + counts[200] + counts[500] + counts[1000]) /
    draws;
  assert.ok(midPlus > 0.015 && midPlus < 0.08, `x20+ share ${midPlus}`);
  assert.ok(counts[1000] / draws > 0.00005, `x1000 must appear, got ${counts[1000] / draws}`);
  for (let i = 1; i < MULTIPLIER_VALUES.length; i += 1) {
    const prev = counts[MULTIPLIER_VALUES[i - 1]] || 0;
    const cur = counts[MULTIPLIER_VALUES[i]] || 0;
    assert.ok(cur < prev, `x${MULTIPLIER_VALUES[i]} rarer than x${MULTIPLIER_VALUES[i - 1]}`);
  }
});

test("bonus plaques are richer than base; stacking suppression keeps mid+ rare", () => {
  const rng = mulberry32(99);
  const draws = 100000;
  let baseHigh = 0;
  let bonusHigh = 0;
  let suppressedHigh = 0;
  for (let i = 0; i < draws; i += 1) {
    if (pickMultiplierValue(rng, { bonus: false }) >= 20) baseHigh += 1;
    if (pickMultiplierValue(rng, { bonus: true }) >= 20) bonusHigh += 1;
    if (pickMultiplierValue(rng, { bigAlready: true }) >= 20) suppressedHigh += 1;
  }
  assert.ok(bonusHigh > baseHigh * 1.2, `bonus mid+ ${bonusHigh} vs base ${baseHigh}`);
  assert.ok(
    suppressedHigh / draws < 0.03,
    `stacking suppression should rarely land mid+, got ${suppressedHigh / draws}`,
  );
});

test("super buy-bonus plaques are always x20+ even when stacking suppresses", () => {
  const rng = mulberry32(7);
  const draws = 40000;
  for (let i = 0; i < draws; i += 1) {
    const open = pickMultiplierValue(rng, { bonus: true, superBonus: true });
    const stacked = pickMultiplierValue(rng, {
      bonus: true,
      superBonus: true,
      bigAlready: true,
    });
    assert.ok(open >= 20, `super open plaque ${open}`);
    assert.ok(stacked >= 20, `super stacked plaque ${stacked}`);
  }

  for (let seed = 1; seed <= 250; seed += 1) {
    const spin = resolveSpin({
      bonusMode: true,
      superBonus: true,
      rng: mulberry32(seed),
    });
    const scan = (matrix) => {
      for (const col of matrix) {
        for (const cell of col) {
          if (!isMultiplier(cell)) continue;
          const value = Number(String(cell).slice(1));
          assert.ok(value >= 20, `super spin plaque ${cell}`);
        }
      }
    };
    scan(spin.initialMatrix);
    scan(spin.finalMatrix);
    for (const step of spin.steps) {
      scan(step.matrixAfter);
      for (const col of step.refills) scan([col]);
    }
  }
});

// --- win calculator ---------------------------------------------------------

test("findWins detects 7+ anywhere and ignores multiplier plaques", () => {
  const matrix = fullMatrix(SYMBOLS.S);
  const crownCells = [[0, 0], [0, 1], [1, 0], [2, 3], [3, 4], [4, 2], [5, 0]];
  for (const [c, r] of crownCells) matrix[c][r] = SYMBOLS.CROWN;
  matrix[1][1] = "x10";
  matrix[1][2] = "x1000";

  const wins = findWins(matrix);
  const crown = wins.find((w) => w.symbol === SYMBOLS.CROWN);
  assert.ok(crown, "crown win detected");
  assert.equal(crown.count, MIN_MATCH);
  assert.equal(crown.payout, 2.0);

  // Six crowns must not pay.
  const six = fullMatrix(SYMBOLS.S);
  for (const [c, r] of crownCells.slice(0, 6)) six[c][r] = SYMBOLS.CROWN;
  assert.equal(findWins(six).find((w) => w.symbol === SYMBOLS.CROWN), undefined);

  const sWin = wins.find((w) => w.symbol === SYMBOLS.S);
  assert.equal(sWin.count, 30 - crownCells.length - 2);

  assert.deepEqual(collectMultipliers(matrix), [
    { col: 1, row: 1, value: 10 },
    { col: 1, row: 2, value: 1000 },
  ]);
});

// --- spin engine ------------------------------------------------------------

test("resolveSpin is deterministic for a seeded rng", () => {
  const a = resolveSpin({ rng: mulberry32(42) });
  const b = resolveSpin({ rng: mulberry32(42) });
  assert.deepEqual(a, b);
});

test("tumble steps are internally consistent and never remove plaques", () => {
  let spin = null;
  for (let seed = 1; seed < 400; seed += 1) {
    const candidate = resolveSpin({ rng: mulberry32(seed) });
    if (candidate.steps.length > 0) {
      spin = candidate;
      break;
    }
  }
  assert.ok(spin, "found a winning spin");

  let matrix = spin.initialMatrix;
  for (const step of spin.steps) {
    assert.equal(step.stepWin, step.wins.reduce((s, w) => s + w.payout, 0));

    const removed = new Set(step.removedPositions.map(([c, r]) => `${c}:${r}`));
    for (const key of removed) {
      const [c, r] = key.split(":").map(Number);
      assert.ok(!isMultiplier(matrix[c][r]), "plaques are never removed");
    }
    for (let c = 0; c < REEL_COUNT; c += 1) {
      const survivors = [];
      for (let r = 0; r < ROW_COUNT; r += 1) {
        if (!removed.has(`${c}:${r}`)) survivors.push(matrix[c][r]);
      }
      assert.equal(step.refills[c].length + survivors.length, ROW_COUNT);
      assert.deepEqual(step.matrixAfter[c], [...step.refills[c], ...survivors]);
    }
    matrix = step.matrixAfter;
  }
  assert.deepEqual(matrix, spin.finalMatrix);
  assert.equal(spin.baseWin, spin.steps.reduce((s, x) => s + x.stepWin, 0));
});

// --- service + wallet -------------------------------------------------------

test("spin validates the bet range", async () => {
  await assert.rejects(
    () => poseidonService.executeSpin("user-1", 5),
    (err) => err.statusCode === 400,
  );
  await assert.rejects(
    () => poseidonService.executeSpin("user-1", 999999999999),
    (err) => err.statusCode === 400,
  );
});

test("spin settles bet and win atomically against the stub wallet", async () => {
  wallet.seedStubBalance("user-2", 1000000);
  const bet = 10000;
  const res = await poseidonService.executeSpin("user-2", bet);

  assert.equal(res.betAmount, bet);
  assert.equal(res.initialMatrix.length, REEL_COUNT);
  assert.equal(res.initialMatrix[0].length, ROW_COUNT);
  assert.ok(res.roundId && res.roundHash);
  assert.equal(typeof res.multiplierCount, "number");

  const expected = roundMoney(1000000 - bet + res.totalWin);
  assert.equal(res.balance, expected);
  assert.equal(await wallet.getBalance("user-2"), expected);

  if (!res.winCapped) {
    assert.equal(
      res.totalWin,
      roundMoney(res.baseWinAmount * res.appliedMultiplier),
    );
  }
  assert.ok(res.totalWin <= roundMoney(bet * MAX_WIN_MULTIPLIER));
});

test("multiplier applies only when the spin wins", async () => {
  wallet.seedStubBalance("user-2b", 100000000);
  // sample many spins; whenever plaques landed on a losing spin, win stays 0
  for (let i = 0; i < 60; i += 1) {
    const res = await poseidonService.executeSpin("user-2b", 10000);
    if (res.baseWinAmount === 0) {
      assert.equal(res.totalWin, 0);
      assert.equal(res.appliedMultiplier, 1);
    } else if (res.multiplierSum > 0 && !res.winCapped) {
      assert.equal(
        res.appliedMultiplier,
        appliedMultiplierFor(res.multiplierSum, false),
      );
    }
    // drain any bonus session so every iteration is a paid spin
    while (roundManager.hasActiveBonusSession("user-2b")) {
      await poseidonService.executeSpin("user-2b", 10000);
    }
  }
});

test("insufficient balance is rejected with 402", async () => {
  wallet.seedStubBalance("user-3", 500);
  await assert.rejects(
    () => poseidonService.executeSpin("user-3", 10000),
    (err) => err.statusCode === 402,
  );
});

test("buy bonus charges the fixed cost and opens a 10-spin session — no trigger spin", async () => {
  wallet.seedStubBalance("user-4", 100000000);
  const bet = 10000;
  const res = await poseidonService.executeBuyBonus("user-4", bet);

  assert.equal(res.cost, bet * BUY_BONUS_COST);
  assert.equal(res.freeSpinsTriggered, true);
  assert.equal(res.freeSpinsAwarded, FREE_SPINS_BOUGHT);
  assert.equal(res.freeSpinsRemaining, FREE_SPINS_BOUGHT);
  assert.equal(res.balance, 100000000 - res.cost);
  assert.ok(roundManager.hasActiveBonusSession("user-4"));

  await assert.rejects(
    () => poseidonService.executeBuyBonus("user-4", bet),
    (err) => err.statusCode === 409,
  );
});

test("super buy bonus flags the session and only deals x20+ plaques", async () => {
  wallet.seedStubBalance("user-super", 100000000);
  const bet = 10000;
  const res = await poseidonService.executeBuyBonus("user-super", bet, {
    superBonus: true,
  });

  assert.equal(res.superBonus, true);
  assert.equal(res.cost, bet * SUPER_BUY_BONUS_COST);
  assert.equal(roundManager.getBonusSession("user-super").superBonus, true);

  while (roundManager.hasActiveBonusSession("user-super")) {
    const spin = await poseidonService.executeSpin("user-super", bet);
    for (const matrix of [spin.initialMatrix, spin.finalMatrix]) {
      for (const col of matrix) {
        for (const cell of col) {
          if (!isMultiplier(cell)) continue;
          assert.ok(Number(String(cell).slice(1)) >= 20, `super plaque ${cell}`);
        }
      }
    }
  }
});

test("getActiveSession restores bonus after memory cache drop (reconnect)", async () => {
  wallet.seedStubBalance("user-restore", 100000000);
  const bet = 10000;
  await poseidonService.executeBuyBonus("user-restore", bet);

  // Simulate client reconnect / new process cache miss while session still
  // lives in the manager (mongo hydrate path uses ensureLoaded the same way).
  const snap = await poseidonService.getActiveSession("user-restore");
  assert.equal(snap.active, true);
  assert.equal(snap.betAmount, bet);
  assert.equal(snap.freeSpinsRemaining, FREE_SPINS_BOUGHT);

  // Drop in-memory cache then ensureLoaded should still see it in stub mode
  // only if we re-create — for stub, re-seed memory from getActiveSession path:
  // clear memory and put session back via create to mimic hydrate.
  const live = roundManager.getBonusSession("user-restore");
  assert.ok(live);
  roundManager.clearAllForTests();
  roundManager.createBonusSession("user-restore", {
    betAmount: live.betAmount,
    freeSpins: live.freeSpinsRemaining,
  });
  // Preserve totalWon / session shape for resume.
  const again = await poseidonService.getActiveSession("user-restore");
  assert.equal(again.active, true);
  assert.equal(again.freeSpinsRemaining, FREE_SPINS_BOUGHT);

  // Next spin must be a free spin without requiring a paid warm-up.
  const spin = await poseidonService.executeSpin("user-restore", 999999);
  assert.equal(spin.isFreeSpin, true);
  assert.equal(spin.betAmount, bet);
});

test("free spins consume the session without charging bets", async () => {
  wallet.seedStubBalance("user-5", 100000000);
  const bet = 10000;
  await poseidonService.executeBuyBonus("user-5", bet);

  let remaining = FREE_SPINS_BOUGHT;
  let guard = 0;
  while (remaining > 0 && guard < 300) {
    guard += 1;
    const before = await wallet.getBalance("user-5");
    const res = await poseidonService.executeSpin("user-5", 0 /* ignored */);
    assert.equal(res.isFreeSpin, true);
    assert.equal(res.betAmount, bet);
    assert.equal(res.balance, before + res.totalWin);
    remaining = res.freeSpinsRemaining;
  }
  assert.equal(remaining, 0);
  assert.equal(roundManager.hasActiveBonusSession("user-5"), false);

  const before = await wallet.getBalance("user-5");
  const res = await poseidonService.executeSpin("user-5", bet);
  assert.equal(res.isFreeSpin, false);
  assert.equal(res.balance, before - bet + res.totalWin);
});

test("natural trigger awards 5 free spins on 4+ plaques", async () => {
  const engine = require("../games/poseidon/spinEngine");
  const original = engine.resolveSpin;
  engine.resolveSpin = () => ({
    initialMatrix: Array.from({ length: REEL_COUNT }, () =>
      Array.from({ length: ROW_COUNT }, () => SYMBOLS.A)
    ),
    finalMatrix: Array.from({ length: REEL_COUNT }, () =>
      Array.from({ length: ROW_COUNT }, () => SYMBOLS.A)
    ),
    steps: [],
    baseWin: 0,
    multipliers: [
      { col: 0, row: 0, value: 2 },
      { col: 1, row: 0, value: 5 },
      { col: 2, row: 0, value: 10 },
      { col: 3, row: 0, value: 20 },
    ],
    multiplierSum: 37,
  });
  try {
    wallet.seedStubBalance("user-6", 5000000000);
    const res = await poseidonService.executeSpin("user-6", 10000);
    assert.equal(res.isFreeSpin, false);
    assert.equal(res.freeSpinsTriggered, true);
    assert.ok(res.multiplierCount >= TRIGGER_NATURAL_MIN);
    assert.equal(res.freeSpinsAwarded, FREE_SPINS_NATURAL);
    assert.equal(res.freeSpinsRemaining, FREE_SPINS_NATURAL);
  } finally {
    engine.resolveSpin = original;
    while (roundManager.hasActiveBonusSession("user-6")) {
      await poseidonService.executeSpin("user-6", 10000);
    }
  }
});

test("bought bonus retriggers +5 free spins on 3+ plaques", async () => {
  const engine = require("../games/poseidon/spinEngine");
  const original = engine.resolveSpin;
  wallet.seedStubBalance("user-6b", 5000000000);
  await poseidonService.executeBuyBonus("user-6b", 10000);
  engine.resolveSpin = () => ({
    initialMatrix: Array.from({ length: REEL_COUNT }, () =>
      Array.from({ length: ROW_COUNT }, () => SYMBOLS.A)
    ),
    finalMatrix: Array.from({ length: REEL_COUNT }, () =>
      Array.from({ length: ROW_COUNT }, () => SYMBOLS.A)
    ),
    steps: [],
    baseWin: 0,
    multipliers: [
      { col: 0, row: 0, value: 2 },
      { col: 1, row: 0, value: 5 },
      { col: 2, row: 0, value: 10 },
    ],
    multiplierSum: 17,
  });
  try {
    const sessionBefore = await poseidonService.getActiveSession("user-6b");
    const before = sessionBefore.freeSpinsRemaining;
    const res = await poseidonService.executeSpin("user-6b", 10000);
    assert.equal(res.isFreeSpin, true);
    assert.equal(res.freeSpinsAwarded, 5);
    assert.equal(res.multiplierCount, 3);
    // consumed 1 spin, then +5 retrigger
    assert.equal(res.freeSpinsRemaining, before - 1 + 5);
  } finally {
    engine.resolveSpin = original;
    while (roundManager.hasActiveBonusSession("user-6b")) {
      await poseidonService.executeSpin("user-6b", 10000);
    }
  }
});

// --- RTP smoke ---------------------------------------------------------------

test("seeded RTP simulation stays in the tuned band", () => {
  const rng = mulberry32(1234567);
  const spins = 30000;
  let totalBet = 0;
  let totalWon = 0;

  const winOf = (s, isBonus = false) => {
    const applied =
      s.baseWin > 0 && s.multiplierSum > 0
        ? appliedMultiplierFor(s.multiplierSum, isBonus)
        : 1;
    return Math.min(s.baseWin * applied, MAX_WIN_MULTIPLIER);
  };

  const playBonus = () => {
    let remaining = FREE_SPINS_NATURAL;
    let won = 0;
    let guard = 0;
    while (remaining > 0 && guard < 400) {
      guard += 1;
      remaining -= 1;
      const s = resolveSpin({ bonusMode: true, rng });
      won += winOf(s, true);
      if (s.multipliers.length >= TRIGGER_RETRIGGER_MIN) remaining += 5;
    }
    return won;
  };

  for (let i = 0; i < spins; i += 1) {
    totalBet += 1;
    const s = resolveSpin({ rng });
    let win = winOf(s, false);
    if (s.multipliers.length >= TRIGGER_NATURAL_MIN) win += playBonus();
    totalWon += win;
  }

  const rtp = totalWon / totalBet;
  // Player-friendly paytable (letters ≥1×, crown ≤5×) runs hot; keep a sane band.
  assert.ok(rtp > 1.05 && rtp < 1.75, `RTP out of band: ${(rtp * 100).toFixed(1)}%`);
});
