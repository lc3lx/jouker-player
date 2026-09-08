process.env.ZENOBIA_WALLET_MODE = "stub";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  REEL_COUNT,
  ROW_COUNT,
  SYMBOLS,
  SCATTER,
  MIN_ROUTE,
  TARGET_RTP,
  TRIGGER_NATURAL_MIN,
  TRIGGER_RETRIGGER_MIN,
  FREE_SPINS_NATURAL,
  FREE_SPINS_BOUGHT,
  RETRIGGER_AWARD,
  BUY_BONUS_COST,
  SUPER_BUY_BONUS_COST,
  MAX_WIN_MULTIPLIER,
  MULTIPLIER_VALUES,
  SUPER_MULTIPLIER_MIN,
  payoutFor,
  winTierFor,
  isMultiplier,
  isRouteBreaker,
  roundMoney,
  resolvePayoutMultiplier,
} = require("../games/zenobia/constants");
const {
  findWins,
  collectMultipliers,
  collectScatters,
  keepMaximalRoutes,
} = require("../games/zenobia/winCalculator");
const {
  resolveSpin,
  pickMultiplierValue,
} = require("../games/zenobia/spinEngine");
const roundManager = require("../games/zenobia/roundManager");
const wallet = require("../games/zenobia/zenobiaWalletAdapter");
const zenobiaService = require("../games/zenobia/zenobiaService");

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

/** Board of `blank` with the given [col,row] cells set to `symbol`. */
function boardWith(cells, symbol, blank = SCATTER) {
  const m = fullMatrix(blank);
  for (const [col, row] of cells) m[col][row] = symbol;
  return m;
}

beforeEach(() => {
  roundManager.clearAllForTests();
  wallet.clearStubForTests();
});

// --- constants / paytable -------------------------------------------------

test("payoutFor pays from MIN_ROUTE up and keeps the design ranking", () => {
  assert.equal(payoutFor(SYMBOLS.QUEEN, MIN_ROUTE - 1), 0);
  assert.ok(payoutFor(SYMBOLS.QUEEN, MIN_ROUTE) > 0);
  for (let len = MIN_ROUTE; len <= REEL_COUNT; len += 1) {
    assert.ok(
      payoutFor(SYMBOLS.QUEEN, len) > payoutFor(SYMBOLS.THRONE, len),
      `queen must out-pay throne at ${len}`,
    );
    assert.ok(
      payoutFor(SYMBOLS.THRONE, len) > payoutFor(SYMBOLS.NECKLACE, len),
      `throne must out-pay necklace at ${len}`,
    );
    assert.ok(
      payoutFor(SYMBOLS.RING, len) > payoutFor(SYMBOLS.A, len),
      `ring must out-pay the letters at ${len}`,
    );
  }
  // Longer routes always pay more than shorter ones.
  assert.ok(payoutFor(SYMBOLS.QUEEN, 6) > payoutFor(SYMBOLS.QUEEN, 5));
  assert.ok(payoutFor(SYMBOLS.QUEEN, 5) > payoutFor(SYMBOLS.QUEEN, 4));
});

test("all four letters share one pay band", () => {
  for (let len = MIN_ROUTE; len <= REEL_COUNT; len += 1) {
    const pays = [SYMBOLS.A, SYMBOLS.E, SYMBOLS.N, SYMBOLS.S].map((s) =>
      payoutFor(s, len),
    );
    assert.equal(new Set(pays).size, 1);
  }
});

test("plaques and the BONUS coin are route breakers, symbols are not", () => {
  assert.ok(isRouteBreaker("x2"));
  assert.ok(isRouteBreaker("x1000"));
  assert.ok(isRouteBreaker(SCATTER));
  assert.ok(!isRouteBreaker(SYMBOLS.QUEEN));
  assert.ok(!isRouteBreaker(SYMBOLS.A));
  assert.ok(isMultiplier("x50"));
  assert.ok(!isMultiplier(SCATTER));
});

test("winTierFor maps bet multiples onto the presentation ladder", () => {
  assert.equal(winTierFor(1), null);
  assert.equal(winTierFor(25), "super");
  assert.equal(winTierFor(50), "mega");
  assert.equal(winTierFor(100), "grand");
  assert.equal(winTierFor(1000), "royal");
});

// --- caravan routes -------------------------------------------------------

test("a straight route across every reel pays the 6-band once", () => {
  const board = boardWith(
    [
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 2],
    ],
    SYMBOLS.QUEEN,
  );
  const wins = findWins(board);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].length, 6);
  assert.equal(wins[0].payout, payoutFor(SYMBOLS.QUEEN, 6));
});

test("a diagonal / zig-zag route pays like a straight one of the same length", () => {
  const board = boardWith(
    [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 1],
      [4, 0],
    ],
    SYMBOLS.POT,
  );
  const wins = findWins(board);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].length, 5);
  assert.equal(wins[0].payout, payoutFor(SYMBOLS.POT, 5));
});

test("routes must start on reel 0 — a mid-board run pays nothing", () => {
  const board = boardWith(
    [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
    ],
    SYMBOLS.QUEEN,
  );
  assert.equal(findWins(board).length, 0);
});

test("steps further than one row apart break the route", () => {
  const board = boardWith(
    [
      [0, 0],
      [1, 1],
      [2, 3],
      [3, 4],
    ],
    SYMBOLS.THRONE,
  );
  assert.equal(findWins(board).length, 0);
});

test("a plaque in the path breaks the route", () => {
  const board = boardWith(
    [
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
    ],
    SYMBOLS.SPEAR,
  );
  assert.equal(findWins(board).length, 1);
  board[2][2] = "x50";
  assert.equal(findWins(board).length, 0);
});

test("a long route never also pays as its own shorter prefix", () => {
  const board = boardWith(
    [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
    ],
    SYMBOLS.NECKLACE,
  );
  const wins = findWins(board);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].length, 5);
});

test("two geometrically distinct routes of the same symbol both pay", () => {
  const board = fullMatrix(SCATTER);
  for (const [c, r] of [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 4],
    [1, 4],
    [2, 4],
  ]) {
    board[c][r] = SYMBOLS.RING;
  }
  const wins = findWins(board);
  assert.equal(wins.length, 2);
  assert.ok(wins.every((w) => w.length === 3));
});

test("keepMaximalRoutes drops prefixes but keeps genuine branches", () => {
  const kept = keepMaximalRoutes([
    { symbol: "queen", length: 3, positions: [[0, 0], [1, 0], [2, 0]] },
    { symbol: "queen", length: 4, positions: [[0, 0], [1, 0], [2, 0], [3, 0]] },
    { symbol: "queen", length: 3, positions: [[0, 1], [1, 1], [2, 1]] },
  ]);
  assert.equal(kept.length, 2);
  assert.ok(kept.some((k) => k.length === 4));
});

test("a full board of one symbol pays one maximal route per reachable start", () => {
  const wins = findWins(fullMatrix(SYMBOLS.A));
  assert.ok(wins.length > 0);
  // Every maximal route on a solid board runs the full width.
  assert.ok(wins.every((w) => w.length === REEL_COUNT));
});

// --- tumble sequence ------------------------------------------------------

test("resolveSpin returns a well-formed 6x5 board and replayable steps", () => {
  const spin = resolveSpin({ rng: mulberry32(4) });
  assert.equal(spin.initialMatrix.length, REEL_COUNT);
  assert.ok(spin.initialMatrix.every((col) => col.length === ROW_COUNT));
  assert.equal(spin.finalMatrix.length, REEL_COUNT);
  assert.ok(spin.finalMatrix.every((col) => col.length === ROW_COUNT));
  for (const step of spin.steps) {
    assert.ok(step.wins.length > 0);
    assert.ok(step.removedPositions.length > 0);
    assert.equal(step.refills.length, REEL_COUNT);
    assert.equal(step.matrixAfter.length, REEL_COUNT);
    // Each cleared cell is reported exactly once even when routes overlap.
    const keys = step.removedPositions.map(([c, r]) => `${c}:${r}`);
    assert.equal(new Set(keys).size, keys.length);
  }
});

test("every refill exactly replaces the cells that were cleared", () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const spin = resolveSpin({ rng: mulberry32(seed) });
    for (const step of spin.steps) {
      const perColumn = new Array(REEL_COUNT).fill(0);
      for (const [col] of step.removedPositions) perColumn[col] += 1;
      for (let col = 0; col < REEL_COUNT; col += 1) {
        assert.equal(step.refills[col].length, perColumn[col]);
      }
    }
  }
});

test("the final board holds exactly the plaques banked across the sequence", () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const spin = resolveSpin({ rng: mulberry32(seed) });
    const initial = collectMultipliers(spin.initialMatrix).length;
    const added = spin.steps.reduce(
      (sum, step) => sum + step.newMultipliers.length,
      0,
    );
    assert.equal(spin.multipliers.length, initial + added);
    assert.equal(
      spin.multiplierSum,
      spin.multipliers.reduce((sum, m) => sum + m.value, 0),
    );
  }
});

test("scatters accumulate the same way — none are ever cleared by a win", () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const spin = resolveSpin({ rng: mulberry32(seed) });
    const initial = collectScatters(spin.initialMatrix).length;
    const added = spin.steps.reduce(
      (sum, step) => sum + step.newScatters.length,
      0,
    );
    assert.equal(spin.scatterCount, initial + added);
    assert.equal(spin.scatterCount, spin.scatters.length);
  }
});

test("the sequence always ends on a board with no payable route", () => {
  for (let seed = 1; seed <= 80; seed += 1) {
    const spin = resolveSpin({ rng: mulberry32(seed) });
    assert.equal(findWins(spin.finalMatrix).length, 0);
  }
});

test("baseWin is the sum of the step wins", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const spin = resolveSpin({ rng: mulberry32(seed) });
    const summed = spin.steps.reduce((sum, s) => sum + s.stepWin, 0);
    assert.ok(Math.abs(spin.baseWin - summed) < 1e-9);
  }
});

// --- plaque faces ---------------------------------------------------------

test("plaque faces always come from the published ladder", () => {
  const rng = mulberry32(11);
  for (let i = 0; i < 4000; i += 1) {
    assert.ok(MULTIPLIER_VALUES.includes(pickMultiplierValue(rng, {})));
    assert.ok(MULTIPLIER_VALUES.includes(pickMultiplierValue(rng, { bonus: true })));
  }
});

test("super buy-bonus never deals a plaque below the royal floor", () => {
  const rng = mulberry32(12);
  for (let i = 0; i < 4000; i += 1) {
    const value = pickMultiplierValue(rng, { bonus: true, superBonus: true });
    assert.ok(value >= SUPER_MULTIPLIER_MIN, `got x${value}`);
  }
});

test("super buy-bonus boards carry no gold plaque", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const spin = resolveSpin({
      bonusMode: true,
      superBonus: true,
      rng: mulberry32(seed),
    });
    for (const plaque of spin.multipliers) {
      assert.ok(plaque.value >= SUPER_MULTIPLIER_MIN, `got x${plaque.value}`);
    }
  }
});

// --- Bonus Box arithmetic -------------------------------------------------

test("base game: the box multiplies this spin only and never carries", () => {
  const { applied, nextCarried } = resolvePayoutMultiplier({
    baseWin: 4,
    plaqueSum: 12,
    carried: 0,
    isFreeSpin: false,
  });
  assert.equal(applied, 12);
  assert.equal(nextCarried, 0);
});

test("base game: a losing spin banks nothing and applies x1", () => {
  const { applied, nextCarried } = resolvePayoutMultiplier({
    baseWin: 0,
    plaqueSum: 500,
    carried: 0,
    isFreeSpin: false,
  });
  assert.equal(applied, 1);
  assert.equal(nextCarried, 0);
});

test("free spins: the box grows only on winning spins and keeps its total", () => {
  let carried = 0;
  let step = resolvePayoutMultiplier({
    baseWin: 2,
    plaqueSum: 10,
    carried,
    isFreeSpin: true,
  });
  assert.equal(step.applied, 10);
  carried = step.nextCarried;
  assert.equal(carried, 10);

  // Losing spin: box holds, applies nothing.
  step = resolvePayoutMultiplier({
    baseWin: 0,
    plaqueSum: 40,
    carried,
    isFreeSpin: true,
  });
  assert.equal(step.applied, 1);
  assert.equal(step.nextCarried, 10);
  carried = step.nextCarried;

  // Next winning spin adds on top of the banked total.
  step = resolvePayoutMultiplier({
    baseWin: 3,
    plaqueSum: 5,
    carried,
    isFreeSpin: true,
  });
  assert.equal(step.applied, 15);
  assert.equal(step.nextCarried, 15);
});

// --- service / wallet -----------------------------------------------------

test("a paid spin debits the bet and credits the win atomically", async () => {
  wallet.seedStubBalance("u1", 10_000_000);
  const res = await zenobiaService.executeSpin("u1", 100_000);
  assert.equal(res.betAmount, 100_000);
  assert.equal(res.isFreeSpin, false);
  assert.equal(res.balance, 10_000_000 - 100_000 + res.totalWin);
  assert.ok(res.roundId);
  assert.ok(res.roundHash);
});

test("a spin below the table minimum is rejected", async () => {
  wallet.seedStubBalance("u2", 10_000_000);
  await assert.rejects(() => zenobiaService.executeSpin("u2", 1), /Bet must be/);
});

test("an empty wallet cannot spin", async () => {
  wallet.seedStubBalance("u3", 1000);
  await assert.rejects(
    () => zenobiaService.executeSpin("u3", 100_000),
    /Insufficient wallet balance/,
  );
});

test("buy bonus charges the published cost and opens the session", async () => {
  wallet.seedStubBalance("u4", 100_000_000);
  const res = await zenobiaService.executeBuyBonus("u4", 100_000);
  assert.equal(res.cost, roundMoney(100_000 * BUY_BONUS_COST));
  assert.equal(res.freeSpinsRemaining, FREE_SPINS_BOUGHT);
  assert.equal(res.balance, 100_000_000 - res.cost);
});

test("super buy bonus costs more and flags the session", async () => {
  wallet.seedStubBalance("u5", 500_000_000);
  const res = await zenobiaService.executeBuyBonus("u5", 100_000, {
    superBonus: true,
  });
  assert.equal(res.cost, roundMoney(100_000 * SUPER_BUY_BONUS_COST));
  assert.equal(res.superBonus, true);
  assert.ok(SUPER_BUY_BONUS_COST > BUY_BONUS_COST);
});

test("a second buy while a session is live is refused", async () => {
  wallet.seedStubBalance("u6", 500_000_000);
  await zenobiaService.executeBuyBonus("u6", 100_000);
  await assert.rejects(
    () => zenobiaService.executeBuyBonus("u6", 100_000),
    /already active/,
  );
});

test("free spins cost nothing and run the session down to zero", async () => {
  wallet.seedStubBalance("u7", 100_000_000);
  const buy = await zenobiaService.executeBuyBonus("u7", 100_000);
  let balance = buy.balance;
  let spins = 0;
  let remaining = buy.freeSpinsRemaining;
  while (remaining > 0 && spins < 300) {
    const res = await zenobiaService.executeSpin("u7", 100_000);
    assert.equal(res.isFreeSpin, true);
    assert.equal(res.balance, balance + res.totalWin);
    balance = res.balance;
    remaining = res.freeSpinsRemaining;
    spins += 1;
  }
  assert.equal(remaining, 0);
  assert.ok(spins >= FREE_SPINS_BOUGHT);
  const after = await zenobiaService.getActiveSession("u7");
  assert.equal(after.active, false);
});

test("an active session is restored for a reconnecting client", async () => {
  wallet.seedStubBalance("u8", 100_000_000);
  const buy = await zenobiaService.executeBuyBonus("u8", 100_000, {
    superBonus: true,
  });
  const session = await zenobiaService.getActiveSession("u8");
  assert.equal(session.active, true);
  assert.equal(session.sessionId, buy.sessionId);
  assert.equal(session.superBonus, true);
  assert.equal(session.freeSpinsRemaining, FREE_SPINS_BOUGHT);
});

test("wins never exceed the published max-win cap", async () => {
  wallet.seedStubBalance("u9", 1_000_000_000);
  for (let i = 0; i < 250; i += 1) {
    const res = await zenobiaService.executeSpin("u9", 10_000);
    assert.ok(res.totalWin <= res.maxWinCap);
  }
});

// --- RTP / trigger simulation --------------------------------------------
//
// The engine is the sole payout authority, so the whole economy is pinned by
// this seeded simulation. Re-run it after touching any weight or pay band.

function simulateFreeSpins(rng, { spins, superBonus }) {
  let total = 0;
  let carried = 0;
  let remaining = spins;
  let guard = 0;
  while (remaining > 0 && guard < 500) {
    guard += 1;
    remaining -= 1;
    const spin = resolveSpin({ bonusMode: true, superBonus, rng });
    const { applied, nextCarried } = resolvePayoutMultiplier({
      baseWin: spin.baseWin,
      plaqueSum: spin.multiplierSum,
      carried,
      isFreeSpin: true,
    });
    carried = nextCarried;
    total += Math.min(spin.baseWin * applied, MAX_WIN_MULTIPLIER);
    if (spin.scatterCount >= TRIGGER_RETRIGGER_MIN) remaining += RETRIGGER_AWARD;
  }
  return total;
}

function simulate(spins, seed) {
  const rng = mulberry32(seed);
  let returned = 0;
  let hits = 0;
  let triggers = 0;
  for (let i = 0; i < spins; i += 1) {
    const spin = resolveSpin({ rng });
    const { applied } = resolvePayoutMultiplier({
      baseWin: spin.baseWin,
      plaqueSum: spin.multiplierSum,
      carried: 0,
      isFreeSpin: false,
    });
    let win = Math.min(spin.baseWin * applied, MAX_WIN_MULTIPLIER);
    if (win > 0) hits += 1;
    if (spin.scatterCount >= TRIGGER_NATURAL_MIN) {
      triggers += 1;
      win += simulateFreeSpins(rng, {
        spins: FREE_SPINS_NATURAL,
        superBonus: false,
      });
    }
    returned += win;
  }
  return { rtp: returned / spins, hitRate: hits / spins, triggerRate: triggers / spins };
}

test("overall RTP sits within tolerance of the target", () => {
  const { rtp } = simulate(120_000, 20260907);
  assert.ok(
    Math.abs(rtp - TARGET_RTP) <= 0.03,
    `RTP ${(rtp * 100).toFixed(2)}% is outside ${(TARGET_RTP * 100).toFixed(1)}% ± 3pp`,
  );
});

test("hit rate keeps the base game alive without paying on every spin", () => {
  const { hitRate } = simulate(60_000, 771);
  assert.ok(hitRate > 0.2 && hitRate < 0.4, `hit rate ${(hitRate * 100).toFixed(2)}%`);
});

test("free spins trigger often enough to be reachable, rarely enough to matter", () => {
  const { triggerRate } = simulate(120_000, 1313);
  const oneIn = 1 / triggerRate;
  assert.ok(oneIn > 150 && oneIn < 450, `free spins 1 in ${oneIn.toFixed(0)}`);
});

test("buy-bonus prices track the free-spins EV at the target RTP", () => {
  for (const [superBonus, cost] of [
    [false, BUY_BONUS_COST],
    [true, SUPER_BUY_BONUS_COST],
  ]) {
    const rng = mulberry32(superBonus ? 5150 : 5151);
    let total = 0;
    const rounds = 12_000;
    for (let i = 0; i < rounds; i += 1) {
      total += simulateFreeSpins(rng, { spins: FREE_SPINS_BOUGHT, superBonus });
    }
    const buyRtp = total / rounds / cost;
    assert.ok(
      Math.abs(buyRtp - TARGET_RTP) <= 0.06,
      `${superBonus ? "super" : "standard"} buy RTP ${(buyRtp * 100).toFixed(2)}%`,
    );
  }
});
