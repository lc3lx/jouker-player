process.env.POSEIDON_WALLET_MODE = "stub";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  REEL_COUNT,
  ROW_COUNT,
  SYMBOLS,
  MIN_MATCH,
  TRIGGER_MIN_MULTIPLIERS,
  FREE_SPINS_NATURAL,
  FREE_SPINS_BOUGHT,
  BUY_BONUS_COST,
  MAX_WIN_MULTIPLIER,
  MULTIPLIER_VALUES,
  payoutFor,
  winTierFor,
  isMultiplier,
  roundMoney,
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

test("payoutFor respects the 8-9 / 10-11 / 12+ bands and the design ranking", () => {
  assert.equal(payoutFor(SYMBOLS.CROWN, 7), 0);
  assert.equal(payoutFor(SYMBOLS.CROWN, 8), 12);
  assert.equal(payoutFor(SYMBOLS.CROWN, 10), 30);
  assert.equal(payoutFor(SYMBOLS.CROWN, 12), 60);

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
      payoutFor(order[i - 1], 8) > payoutFor(order[i], 8),
      `${order[i - 1]} must outrank ${order[i]}`,
    );
  }

  // the four letters pay identically
  for (const letter of [SYMBOLS.E, SYMBOLS.N, SYMBOLS.S]) {
    for (const count of [8, 10, 12]) {
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

// --- multiplier gate cascade -------------------------------------------------

test("gate cascade: x2 dominates at ~90%, higher values keep the design ratios", () => {
  const rng = mulberry32(2024);
  const counts = {};
  const draws = 200000;
  for (let i = 0; i < draws; i += 1) {
    const v = pickMultiplierValue(rng);
    counts[v] = (counts[v] || 0) + 1;
  }
  assert.ok(Math.abs(counts[2] / draws - 0.9) < 0.01, `x2 ≈ 90%, got ${counts[2] / draws}`);
  assert.ok(Math.abs(counts[5] / draws - 0.07) < 0.01, `x5 ≈ 7%, got ${counts[5] / draws}`);
  // strictly decreasing frequency up the value ladder
  for (let i = 1; i < MULTIPLIER_VALUES.length; i += 1) {
    const prev = counts[MULTIPLIER_VALUES[i - 1]] || 0;
    const cur = counts[MULTIPLIER_VALUES[i]] || 0;
    assert.ok(cur < prev, `x${MULTIPLIER_VALUES[i]} rarer than x${MULTIPLIER_VALUES[i - 1]}`);
  }
});

// --- win calculator ---------------------------------------------------------

test("findWins detects 8+ anywhere and ignores multiplier plaques", () => {
  const matrix = fullMatrix(SYMBOLS.S);
  const crownCells = [[0, 0], [0, 1], [1, 0], [2, 3], [3, 4], [4, 2], [5, 0], [5, 4]];
  for (const [c, r] of crownCells) matrix[c][r] = SYMBOLS.CROWN;
  matrix[1][1] = "x10";
  matrix[1][2] = "x1000";

  const wins = findWins(matrix);
  const crown = wins.find((w) => w.symbol === SYMBOLS.CROWN);
  assert.ok(crown, "crown win detected");
  assert.equal(crown.count, MIN_MATCH);
  assert.equal(crown.payout, 12);

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
      assert.equal(res.appliedMultiplier, res.multiplierSum);
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

test("natural trigger awards 5 free spins on 3+ plaques", async () => {
  wallet.seedStubBalance("user-6", 5000000000);
  let triggered = null;
  for (let i = 0; i < 3000 && !triggered; i += 1) {
    const res = await poseidonService.executeSpin("user-6", 10000);
    if (!res.isFreeSpin && res.freeSpinsTriggered) triggered = res;
    while (!triggered && roundManager.hasActiveBonusSession("user-6")) {
      await poseidonService.executeSpin("user-6", 10000);
    }
  }
  assert.ok(triggered, "no natural trigger in 3000 spins (expected ~1/150)");
  assert.ok(triggered.multiplierCount >= TRIGGER_MIN_MULTIPLIERS);
  assert.equal(triggered.freeSpinsAwarded, FREE_SPINS_NATURAL);
  assert.equal(triggered.freeSpinsRemaining, FREE_SPINS_NATURAL);
});

// --- RTP smoke ---------------------------------------------------------------

test("seeded RTP simulation stays in the tuned band", () => {
  const rng = mulberry32(1234567);
  const spins = 30000;
  let totalBet = 0;
  let totalWon = 0;

  const winOf = (s) => {
    const applied = s.baseWin > 0 && s.multiplierSum > 0 ? s.multiplierSum : 1;
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
      won += winOf(s);
      if (s.multipliers.length >= TRIGGER_MIN_MULTIPLIERS) remaining += 5;
    }
    return won;
  };

  for (let i = 0; i < spins; i += 1) {
    totalBet += 1;
    const s = resolveSpin({ rng });
    let win = winOf(s);
    if (s.multipliers.length >= TRIGGER_MIN_MULTIPLIERS) win += playBonus();
    totalWon += win;
  }

  const rtp = totalWon / totalBet;
  // Tuned to ~93% over 400k spins; a seeded 30k run must stay in a sane band.
  assert.ok(rtp > 0.78 && rtp < 1.1, `RTP out of band: ${(rtp * 100).toFixed(1)}%`);
});
