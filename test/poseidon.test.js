process.env.POSEIDON_WALLET_MODE = "stub";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  REEL_COUNT,
  ROW_COUNT,
  SYMBOLS,
  MIN_MATCH,
  FREE_SPINS_AWARD,
  TRIGGER_MIN_SCATTERS,
  BUY_BONUS_COST,
  MAX_WIN_MULTIPLIER,
  payoutFor,
  scatterPayFor,
  winTierFor,
  isMultiplier,
  roundMoney,
} = require("../games/poseidon/constants");
const { findWins, countScatters, collectMultipliers } = require("../games/poseidon/winCalculator");
const { resolveSpin } = require("../games/poseidon/spinEngine");
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

test("payoutFor respects the 8-9 / 10-11 / 12+ bands", () => {
  assert.equal(payoutFor(SYMBOLS.PEARL, 7), 0);
  assert.equal(payoutFor(SYMBOLS.PEARL, 8), 10);
  assert.equal(payoutFor(SYMBOLS.PEARL, 9), 10);
  assert.equal(payoutFor(SYMBOLS.PEARL, 10), 25);
  assert.equal(payoutFor(SYMBOLS.PEARL, 12), 50);
  assert.equal(payoutFor(SYMBOLS.PEARL, 30), 50);
  assert.equal(payoutFor(SYMBOLS.S, 8), 0.2);
});

test("scatterPayFor pays 4/5/6+ orbs", () => {
  assert.equal(scatterPayFor(3), 0);
  assert.equal(scatterPayFor(4), 3);
  assert.equal(scatterPayFor(5), 5);
  assert.equal(scatterPayFor(6), 100);
  assert.equal(scatterPayFor(9), 100);
});

test("winTierFor maps bet multiples to banners", () => {
  assert.equal(winTierFor(10), null);
  assert.equal(winTierFor(25), "super");
  assert.equal(winTierFor(60), "mega");
  assert.equal(winTierFor(120), "grand");
  assert.equal(winTierFor(400), "jackpot");
});

// --- win calculator ---------------------------------------------------------

test("findWins detects 8+ anywhere and ignores orbs/multipliers", () => {
  const matrix = fullMatrix(SYMBOLS.S);
  // reduce pearl to exactly MIN_MATCH cells; rest stays S
  const pearlCells = [[0, 0], [0, 1], [1, 0], [2, 3], [3, 4], [4, 2], [5, 0], [5, 4]];
  for (const [c, r] of pearlCells) matrix[c][r] = SYMBOLS.PEARL;
  matrix[1][1] = SYMBOLS.ORB;
  matrix[1][2] = "x10";

  const wins = findWins(matrix);
  const pearl = wins.find((w) => w.symbol === SYMBOLS.PEARL);
  assert.ok(pearl, "pearl win detected");
  assert.equal(pearl.count, MIN_MATCH);
  assert.equal(pearl.payout, 10);

  const sWin = wins.find((w) => w.symbol === SYMBOLS.S);
  assert.ok(sWin, "s win detected");
  assert.equal(sWin.count, 30 - pearlCells.length - 2);

  assert.equal(countScatters(matrix), 1);
  assert.deepEqual(collectMultipliers(matrix), [{ col: 1, row: 2, value: 10 }]);
});

test("findWins returns nothing below 8 matches", () => {
  const matrix = fullMatrix(SYMBOLS.S);
  const symbols = [SYMBOLS.A, SYMBOLS.E, SYMBOLS.N, SYMBOLS.CROWN, SYMBOLS.FISH];
  let i = 0;
  // paint the grid so no symbol reaches 8 (30 cells / 5 symbols = 6 each)
  for (let c = 0; c < REEL_COUNT; c += 1) {
    for (let r = 0; r < ROW_COUNT; r += 1) {
      matrix[c][r] = symbols[i % symbols.length];
      i += 1;
    }
  }
  assert.deepEqual(findWins(matrix), []);
});

// --- spin engine ------------------------------------------------------------

test("resolveSpin is deterministic for a seeded rng", () => {
  const a = resolveSpin({ rng: mulberry32(42) });
  const b = resolveSpin({ rng: mulberry32(42) });
  assert.deepEqual(a, b);
});

test("tumble steps are internally consistent", () => {
  // find a seed with at least one tumble step
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
    for (let c = 0; c < REEL_COUNT; c += 1) {
      const survivors = [];
      for (let r = 0; r < ROW_COUNT; r += 1) {
        if (!removed.has(`${c}:${r}`)) survivors.push(matrix[c][r]);
      }
      assert.equal(step.refills[c].length + survivors.length, ROW_COUNT);
      assert.deepEqual(step.matrixAfter[c], [...step.refills[c], ...survivors]);
      // refills never add scatters
      for (const cell of step.refills[c]) assert.notEqual(cell, SYMBOLS.ORB);
    }
    matrix = step.matrixAfter;
  }
  assert.deepEqual(matrix, spin.finalMatrix);
  assert.equal(spin.baseWin, spin.steps.reduce((s, x) => s + x.stepWin, 0));
});

test("forceScatters guarantees the free-spin trigger count", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const spin = resolveSpin({
      forceScatters: TRIGGER_MIN_SCATTERS,
      rng: mulberry32(seed),
    });
    assert.ok(spin.scatterCount >= TRIGGER_MIN_SCATTERS);
  }
});

test("multiplier cells are well-formed", () => {
  const spin = resolveSpin({ bonusMode: true, rng: mulberry32(77) });
  for (const m of spin.multipliers) {
    assert.ok(isMultiplier(spin.finalMatrix[m.col][m.row]));
    assert.ok([2, 5, 10, 20, 50].includes(m.value));
  }
  assert.equal(
    spin.multiplierSum,
    spin.multipliers.reduce((s, m) => s + m.value, 0),
  );
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

  const expected = roundMoney(1000000 - bet + res.totalWin);
  assert.equal(res.balance, expected);
  assert.equal(await wallet.getBalance("user-2"), expected);

  if (!res.winCapped) {
    const tumbleWin = roundMoney(res.baseWinAmount * res.appliedMultiplier);
    assert.ok(Math.abs(res.totalWin - (tumbleWin + res.scatterPayAmount)) <= 1);
  }
  assert.ok(res.totalWin <= roundMoney(bet * MAX_WIN_MULTIPLIER));
});

test("insufficient balance is rejected with 402", async () => {
  wallet.seedStubBalance("user-3", 500);
  await assert.rejects(
    () => poseidonService.executeSpin("user-3", 10000),
    (err) => err.statusCode === 402,
  );
});

test("buy bonus charges 100x bet and opens a 15-spin session", async () => {
  wallet.seedStubBalance("user-4", 100000000);
  const bet = 10000;
  const res = await poseidonService.executeBuyBonus("user-4", bet);

  assert.equal(res.cost, bet * BUY_BONUS_COST);
  assert.ok(res.scatterCount >= TRIGGER_MIN_SCATTERS);
  assert.equal(res.freeSpinsTriggered, true);
  assert.equal(res.freeSpinsRemaining, FREE_SPINS_AWARD);
  assert.ok(roundManager.hasActiveBonusSession("user-4"));

  // trigger spin pays no extra bet: balance = seed - cost + trigger win
  assert.equal(res.balance, 100000000 - res.cost + res.totalWin);

  // second purchase while active is rejected
  await assert.rejects(
    () => poseidonService.executeBuyBonus("user-4", bet),
    (err) => err.statusCode === 409,
  );
});

test("free spins consume the session without charging bets", async () => {
  wallet.seedStubBalance("user-5", 100000000);
  const bet = 10000;
  await poseidonService.executeBuyBonus("user-5", bet);

  let remaining = FREE_SPINS_AWARD;
  let guard = 0;
  while (remaining > 0 && guard < 200) {
    guard += 1;
    const before = await wallet.getBalance("user-5");
    const res = await poseidonService.executeSpin("user-5", 0 /* ignored */);
    assert.equal(res.isFreeSpin, true);
    assert.equal(res.betAmount, bet);
    // free spin never debits — balance only grows by the win
    assert.equal(res.balance, before + res.totalWin);
    assert.ok(res.bonusTotalMultiplier >= 0);
    remaining = res.freeSpinsRemaining;
  }
  assert.equal(remaining, 0);
  assert.equal(roundManager.hasActiveBonusSession("user-5"), false);

  // next spin is a paid base-game spin again
  const before = await wallet.getBalance("user-5");
  const res = await poseidonService.executeSpin("user-5", bet);
  assert.equal(res.isFreeSpin, false);
  assert.equal(res.balance, before - bet + res.totalWin);
});

// --- RTP smoke ---------------------------------------------------------------

test("seeded RTP simulation stays in the tuned band", () => {
  const rng = mulberry32(1234567);
  const spins = 30000;
  let totalBet = 0;
  let totalWon = 0;

  const playBonus = () => {
    let remaining = FREE_SPINS_AWARD;
    let totalMultiplier = 0;
    let won = 0;
    let guard = 0;
    while (remaining > 0 && guard < 500) {
      guard += 1;
      remaining -= 1;
      const s = resolveSpin({ bonusMode: true, rng });
      let applied = 1;
      if (s.baseWin > 0 && s.multiplierSum > 0) {
        totalMultiplier += s.multiplierSum;
        applied = totalMultiplier;
      }
      won += Math.min(
        s.baseWin * applied + scatterPayFor(s.scatterCount),
        MAX_WIN_MULTIPLIER,
      );
      if (s.scatterCount >= 3) remaining += 5;
    }
    return won;
  };

  for (let i = 0; i < spins; i += 1) {
    totalBet += 1;
    const s = resolveSpin({ rng });
    const mult = s.baseWin > 0 && s.multiplierSum > 0 ? s.multiplierSum : 1;
    let win = Math.min(
      s.baseWin * mult + scatterPayFor(s.scatterCount),
      MAX_WIN_MULTIPLIER,
    );
    if (s.scatterCount >= TRIGGER_MIN_SCATTERS) win += playBonus();
    totalWon += win;
  }

  const rtp = totalWon / totalBet;
  // Tuned to ~95% over 400k spins; the seeded 30k run must stay in a sane band.
  assert.ok(rtp > 0.8 && rtp < 1.1, `RTP out of band: ${(rtp * 100).toFixed(1)}%`);
});
