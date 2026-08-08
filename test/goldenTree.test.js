process.env.GOLDEN_TREE_WALLET_MODE = "stub";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ADJACENT_PATHS,
  SYMBOLS,
  roundMoney,
} = require("../games/goldenTree/constants");
const { matchPayline, calculateWins, basePayout } = require("../games/goldenTree/winCalculator");
const { generateSpin } = require("../games/goldenTree/spinEngine");
const roundManager = require("../games/goldenTree/roundManager");
const wallet = require("../games/goldenTree/goldenTreeWalletAdapter");
const goldenTreeService = require("../games/goldenTree/goldenTreeService");

function emptyMatrix(fill = SYMBOLS.CHERRY) {
  return Array.from({ length: 5 }, () => Array(3).fill(fill));
}

test("consecutive-column paths only allow touching row connections", () => {
  assert.equal(ADJACENT_PATHS.length, 99);
  for (const path of ADJACENT_PATHS) {
    assert.equal(path.length, 5);
    assert.ok(path.every((row) => row >= 0 && row < 3));
    assert.ok(
      path.every(
        (row, index) => index === 0 || Math.abs(row - path[index - 1]) <= 1,
      ),
    );
  }
  assert.ok(
    ADJACENT_PATHS.some(
      (p) => p[0] === 0 && p[1] === 1 && p[2] === 2 && p[3] === 1 && p[4] === 0,
    ),
  );
  assert.equal(
    ADJACENT_PATHS.some((p) => p[0] === 0 && p[1] === 2),
    false,
  );
});

test("payline parser — left-to-right with wild substitution", () => {
  const symbols = [SYMBOLS.WILD, SYMBOLS.WILD, SYMBOLS.CHERRY, SYMBOLS.PINEAPPLE, SYMBOLS.PLUM];
  const match = matchPayline(symbols);
  assert.equal(match.count, 3);
  assert.equal(match.symbol, SYMBOLS.CHERRY);
});

test("every line symbol needs at least 3 matches", () => {
  assert.equal(basePayout(SYMBOLS.SEVEN, 2, 10000), 0);
  assert.equal(basePayout(SYMBOLS.SEVEN, 3, 10000), 10000);
});

test("diagonal path pays in main (no expand)", () => {
  const matrix = emptyMatrix(SYMBOLS.BANANA);
  for (let col = 0; col < 5; col += 1) {
    for (let row = 0; row < 3; row += 1) {
      matrix[col][row] = SYMBOLS.PLUM;
    }
  }
  matrix[0][0] = SYMBOLS.CHERRY;
  matrix[1][1] = SYMBOLS.CHERRY;
  matrix[2][2] = SYMBOLS.CHERRY;

  const result = calculateWins(matrix, {}, 10000, { bonusMode: false });
  assert.ok(result.lineWins.length >= 1);
  const win = result.lineWins.find(
    (w) =>
      w.symbol === SYMBOLS.CHERRY &&
      w.count === 3 &&
      w.positions[0].row === 0 &&
      w.positions[1].row === 1 &&
      w.positions[2].row === 2,
  );
  assert.ok(win, "expected diagonal cherry win");
  assert.equal(win.amount, 2000);
  assert.equal(result.expandedWilds.length, 0);
});

test("screenshot-style separated sevens do not form a win", () => {
  const matrix = emptyMatrix(SYMBOLS.BANANA);
  // Reels 0→2: bottom seven → top seven → middle seven. The first
  // connection skips over a row, so the symbols do not touch and must not pay.
  matrix[0][2] = SYMBOLS.SEVEN;
  matrix[1][0] = SYMBOLS.SEVEN;
  matrix[2][1] = SYMBOLS.SEVEN;

  const result = calculateWins(matrix, {}, 10000, { bonusMode: false });
  const sevenWins = result.lineWins.filter((w) => w.symbol === SYMBOLS.SEVEN);
  assert.equal(sevenWins.length, 0);
});

test("a skipped column never connects a win path", () => {
  const matrix = emptyMatrix(SYMBOLS.BANANA);
  matrix[0][0] = SYMBOLS.CHERRY;
  matrix[1][1] = SYMBOLS.CHERRY;
  matrix[3][0] = SYMBOLS.CHERRY;

  const result = calculateWins(matrix, {}, 10000, { bonusMode: false });
  const cherryWins = result.lineWins.filter((w) => w.symbol === SYMBOLS.CHERRY);
  assert.equal(cherryWins.length, 0);
});

test("gap in the middle stops the run — no skip to later cherries", () => {
  const matrix = emptyMatrix(SYMBOLS.BANANA);
  for (let col = 0; col < 5; col += 1) {
    for (let row = 0; row < 3; row += 1) {
      matrix[col][row] = SYMBOLS.ORANGE;
    }
  }
  // Middle row: C C X C C — must NOT pay 4/5 cherries by jumping the gap.
  matrix[0][1] = SYMBOLS.CHERRY;
  matrix[1][1] = SYMBOLS.CHERRY;
  matrix[2][1] = SYMBOLS.ORANGE;
  matrix[3][1] = SYMBOLS.CHERRY;
  matrix[4][1] = SYMBOLS.CHERRY;

  const result = calculateWins(matrix, {}, 10000, { bonusMode: false });
  const cherryWins = result.lineWins.filter((w) => w.symbol === SYMBOLS.CHERRY);
  assert.equal(cherryWins.length, 0);
  assert.ok(
    cherryWins.every((w) => w.count < 4),
    "must not pay across a broken shape",
  );
});

test("wins must start on column 0 — mid-board run is not a win", () => {
  const matrix = emptyMatrix(SYMBOLS.BANANA);
  for (let col = 0; col < 5; col += 1) {
    for (let row = 0; row < 3; row += 1) {
      matrix[col][row] = SYMBOLS.ORANGE;
    }
  }
  matrix[1][1] = SYMBOLS.CHERRY;
  matrix[2][1] = SYMBOLS.CHERRY;
  matrix[3][1] = SYMBOLS.CHERRY;
  matrix[4][1] = SYMBOLS.CHERRY;

  const result = calculateWins(matrix, {}, 10000, { bonusMode: false });
  const cherryWins = result.lineWins.filter((w) => w.symbol === SYMBOLS.CHERRY);
  assert.equal(cherryWins.length, 0);
});

test("horizontal contiguous run from col 0 pays", () => {
  const matrix = emptyMatrix(SYMBOLS.BANANA);
  for (let col = 0; col < 5; col += 1) {
    for (let row = 0; row < 3; row += 1) {
      matrix[col][row] = SYMBOLS.ORANGE;
    }
  }
  matrix[0][1] = SYMBOLS.CHERRY;
  matrix[1][1] = SYMBOLS.CHERRY;
  matrix[2][1] = SYMBOLS.CHERRY;

  const result = calculateWins(matrix, {}, 10000, { bonusMode: false });
  const win = result.lineWins.find(
    (w) =>
      w.symbol === SYMBOLS.CHERRY &&
      w.count === 3 &&
      w.positions.every((p, i) => p.col === i && p.row === 1),
  );
  assert.ok(win, "expected horizontal cherry win from col 0");
  assert.equal(win.amount, 2000);
});

test("landscape screenshot board — oranges with reel gaps pay nothing", () => {
  // 5 reels left→right, 3 rows top→bottom (phone landscape).
  // Oranges on reels 0,2,4 with bananas/pineapples on 1 and 3 = broken shape.
  const matrix = [
    [SYMBOLS.SEVEN, SYMBOLS.ORANGE, SYMBOLS.ORANGE],
    [SYMBOLS.PINEAPPLE, SYMBOLS.BANANA, SYMBOLS.BANANA],
    [SYMBOLS.ORANGE, SYMBOLS.ORANGE, SYMBOLS.SEVEN],
    [SYMBOLS.PINEAPPLE, SYMBOLS.PINEAPPLE, SYMBOLS.BANANA],
    [SYMBOLS.ORANGE, SYMBOLS.SEVEN, SYMBOLS.SEVEN],
  ];
  const result = calculateWins(matrix, {}, 10000, { bonusMode: false });
  assert.equal(result.totalWin, 0);
  assert.equal(result.lineWins.length, 0);
});

test("two sevens do not pay across missing reels", () => {
  const matrix = [
    [SYMBOLS.ORANGE, SYMBOLS.SEVEN, SYMBOLS.SEVEN],
    [SYMBOLS.BELL, SYMBOLS.BELL, SYMBOLS.SEVEN],
    [SYMBOLS.ORANGE, SYMBOLS.ORANGE, SYMBOLS.ORANGE],
    [SYMBOLS.CHERRY, SYMBOLS.CHERRY, SYMBOLS.ORANGE],
    [SYMBOLS.ORANGE, SYMBOLS.ORANGE, SYMBOLS.SEVEN],
  ];
  const result = calculateWins(matrix, {}, 10000, { bonusMode: false });
  const sevenWins = result.lineWins.filter((w) => w.symbol === SYMBOLS.SEVEN);
  assert.equal(sevenWins.length, 0);
  assert.equal(result.totalWin, 0);
});

test("row-major 3×5 payload is transposed to landscape 5×3", () => {
  const { normalizeLandscapeMatrix } = require("../games/goldenTree/winCalculator");
  const rowMajor = [
    [SYMBOLS.SEVEN, SYMBOLS.PINEAPPLE, SYMBOLS.ORANGE, SYMBOLS.PINEAPPLE, SYMBOLS.ORANGE],
    [SYMBOLS.ORANGE, SYMBOLS.BANANA, SYMBOLS.ORANGE, SYMBOLS.PINEAPPLE, SYMBOLS.SEVEN],
    [SYMBOLS.ORANGE, SYMBOLS.BANANA, SYMBOLS.SEVEN, SYMBOLS.BANANA, SYMBOLS.SEVEN],
  ];
  const m = normalizeLandscapeMatrix(rowMajor);
  assert.equal(m.length, 5);
  assert.equal(m[0].length, 3);
  assert.equal(m[0][0], SYMBOLS.SEVEN);
  assert.equal(m[0][1], SYMBOLS.ORANGE);
  assert.equal(m[2][0], SYMBOLS.ORANGE);
  const result = calculateWins(rowMajor, {}, 10000, { bonusMode: false });
  assert.equal(result.totalWin, 0);
});

test("wild connector in the middle completes a match (main)", () => {
  const matrix = emptyMatrix(SYMBOLS.BANANA);
  for (let col = 0; col < 5; col += 1) {
    for (let row = 0; row < 3; row += 1) {
      matrix[col][row] = SYMBOLS.ORANGE;
    }
  }
  matrix[0][1] = SYMBOLS.SEVEN;
  matrix[1][1] = SYMBOLS.WILD;
  matrix[2][1] = SYMBOLS.SEVEN;

  const result = calculateWins(matrix, { 1: 2 }, 10000, { bonusMode: false });
  assert.equal(result.expandedWilds.length, 0);
  assert.equal(result.expandedMatrix[1][0], SYMBOLS.ORANGE);
  const win = result.lineWins.find(
    (w) => w.symbol === SYMBOLS.SEVEN && w.count === 3,
  );
  assert.ok(win);
  assert.equal(win.wildMultiplier, 1);
});

test("fruit needs 3; longer runs pay more", () => {
  const matrix3 = emptyMatrix(SYMBOLS.BANANA);
  for (let col = 0; col < 5; col += 1) {
    for (let row = 0; row < 3; row += 1) matrix3[col][row] = SYMBOLS.ORANGE;
  }
  matrix3[0][1] = SYMBOLS.GRAPES;
  matrix3[1][1] = SYMBOLS.GRAPES;
  const noWin = calculateWins(matrix3, {}, 10000, { bonusMode: false });
  assert.equal(
    noWin.lineWins.filter((w) => w.symbol === SYMBOLS.GRAPES).length,
    0,
  );

  matrix3[2][1] = SYMBOLS.GRAPES;
  const win3 = calculateWins(matrix3, {}, 10000, { bonusMode: false });
  const g3 = win3.lineWins.find((w) => w.symbol === SYMBOLS.GRAPES && w.count === 3);
  assert.ok(g3);
  assert.equal(g3.baseAmount, 8000);

  matrix3[3][1] = SYMBOLS.GRAPES;
  const win4 = calculateWins(matrix3, {}, 10000, { bonusMode: false });
  const g4 = win4.lineWins.find((w) => w.symbol === SYMBOLS.GRAPES && w.count === 4);
  assert.ok(g4);
  assert.equal(g4.baseAmount, 24000);
  assert.ok(g4.baseAmount > g3.baseAmount);
});

test("wild multipliers add on bonus line win", () => {
  const matrix = emptyMatrix();
  matrix[0] = [SYMBOLS.WILD, SYMBOLS.WILD, SYMBOLS.WILD];
  matrix[1] = [SYMBOLS.WILD, SYMBOLS.WILD, SYMBOLS.WILD];
  matrix[2][1] = SYMBOLS.CHERRY;
  matrix[3][1] = SYMBOLS.ORANGE;
  matrix[4][1] = SYMBOLS.PLUM;

  const wildMults = { 0: 2, 1: 3 };
  const result = calculateWins(matrix, wildMults, 1, { bonusMode: true });
  assert.ok(result.totalWin > 0);
  assert.ok(result.lineWins.some((w) => w.wildMultiplier === 5));
});

test("payline parser — all-wild run defaults to seven", () => {
  const match = matchPayline(Array(5).fill(SYMBOLS.WILD));
  assert.equal(match.count, 5);
  assert.equal(match.symbol, SYMBOLS.SEVEN);
});

test("bonus expanding wild substitutes the whole reel", () => {
  const matrix = [
    [SYMBOLS.BELL, SYMBOLS.PLUM, SYMBOLS.ORANGE],
    [SYMBOLS.GRAPES, SYMBOLS.WILD, SYMBOLS.BANANA],
    [SYMBOLS.BELL, SYMBOLS.GRAPES, SYMBOLS.WATERMELON],
    [SYMBOLS.PLUM, SYMBOLS.ORANGE, SYMBOLS.GRAPES],
    [SYMBOLS.ORANGE, SYMBOLS.WATERMELON, SYMBOLS.PLUM],
  ];

  const result = calculateWins(matrix, { 1: 3 }, 10000, { bonusMode: true });

  assert.equal(result.expandedMatrix[1][0], SYMBOLS.WILD);
  assert.equal(result.expandedMatrix[1][2], SYMBOLS.WILD);
  assert.equal(result.expandedWilds.length, 1);
  assert.equal(result.expandedWilds[0].multiplier, 3);

  const win = result.lineWins.find(
    (w) =>
      w.symbol === SYMBOLS.BELL &&
      w.count === 3 &&
      w.positions[0].col === 0 &&
      w.positions[0].row === 0 &&
      w.positions[1].col === 1 &&
      w.positions[1].row === 0,
  );
  assert.ok(win, "expected top-row bell win via expanded wild");
  assert.equal(win.baseAmount, 4000);
  assert.equal(win.wildMultiplier, 3);
  assert.equal(win.amount, 12000);
});

test("main mode does not expand wilds", () => {
  const matrix = [
    [SYMBOLS.BELL, SYMBOLS.PLUM, SYMBOLS.ORANGE],
    [SYMBOLS.GRAPES, SYMBOLS.WILD, SYMBOLS.BANANA],
    [SYMBOLS.BELL, SYMBOLS.GRAPES, SYMBOLS.WATERMELON],
    [SYMBOLS.PLUM, SYMBOLS.ORANGE, SYMBOLS.GRAPES],
    [SYMBOLS.ORANGE, SYMBOLS.WATERMELON, SYMBOLS.PLUM],
  ];

  const result = calculateWins(matrix, { 1: 3 }, 10000, { bonusMode: false });
  assert.equal(result.expandedWilds.length, 0);
  assert.equal(result.expandedMatrix[1][0], SYMBOLS.GRAPES);
  assert.equal(result.expandedMatrix[1][2], SYMBOLS.BANANA);
});

test("expanding wild preserves scatters and jackpots on the same reel (bonus)", () => {
  const matrix = [
    [SYMBOLS.BELL, SYMBOLS.PLUM, SYMBOLS.ORANGE],
    [SYMBOLS.DOLLAR, SYMBOLS.WILD, SYMBOLS.JACKPOT],
    [SYMBOLS.BELL, SYMBOLS.GRAPES, SYMBOLS.WATERMELON],
    [SYMBOLS.PLUM, SYMBOLS.ORANGE, SYMBOLS.DOLLAR],
    [SYMBOLS.DOLLAR, SYMBOLS.WATERMELON, SYMBOLS.PLUM],
  ];

  const result = calculateWins(matrix, { 1: 2 }, 10000, { bonusMode: true });

  assert.equal(result.expandedMatrix[1][0], SYMBOLS.DOLLAR);
  assert.equal(result.expandedMatrix[1][2], SYMBOLS.JACKPOT);
  assert.equal(result.scatterWins.length, 1);
  assert.equal(result.scatterWins[0].kind, SYMBOLS.DOLLAR);
  assert.equal(result.scatterWins[0].count, 3);
  assert.equal(result.scatterWins[0].amount, 10000);
});

test("max win cap at 10,000x bet", () => {
  const { capWin } = require("../games/goldenTree/goldenTreeService");
  const { totalWin, capped, cap } = capWin(2_000_000, 100);
  assert.equal(capped, true);
  assert.equal(totalWin, 1_000_000);
  assert.equal(cap, 1_000_000);
});

test("spin deducts bet and credits win (stub wallet)", async () => {
  wallet.clearStubForTests();
  roundManager.clearAllForTests();
  wallet.seedStubBalance("u1", 500000);

  const before = await wallet.getBalance("u1");
  const result = await goldenTreeService.executeSpin("u1", 10000);
  const after = await wallet.getBalance("u1");

  assert.equal(result.betAmount, 10000);
  assert.equal(roundMoney(after - before), roundMoney(result.totalWin - 10000));
  assert.ok(result.roundId);
  assert.ok(result.roundHash);
  assert.equal(result.matrix.length, 5);
  assert.equal(result.matrix[0].length, 3);
});

test("winning spin credits net (win - bet) to the wallet", async () => {
  wallet.clearStubForTests();
  roundManager.clearAllForTests();
  wallet.seedStubBalance("uwin", 1_000_000);

  const before = await wallet.getBalance("uwin");
  const balanceAfter = await wallet.atomicSpinWallet("uwin", {
    betAmount: 10000,
    winAmount: 50000,
    meta: { type: "main_spin" },
  });

  assert.equal(balanceAfter, roundMoney(before - 10000 + 50000));
  assert.equal(await wallet.getBalance("uwin"), balanceAfter);
});

test("settlement is all-or-nothing on insufficient funds (no partial debit)", async () => {
  wallet.clearStubForTests();
  roundManager.clearAllForTests();
  wallet.seedStubBalance("upoor", 5000);

  const before = await wallet.getBalance("upoor");
  await assert.rejects(
    () => wallet.atomicSpinWallet("upoor", { betAmount: 10000, winAmount: 0 }),
    (err) => err.code === "INSUFFICIENT_BALANCE",
  );
  assert.equal(await wallet.getBalance("upoor"), before);
});

test("gamble feature is disabled", async () => {
  wallet.clearStubForTests();
  roundManager.clearAllForTests();
  wallet.seedStubBalance("u2", 500000);

  const spin = await goldenTreeService.executeSpin("u2", 10000);
  assert.equal(spin.gambleEligible, false);

  if (spin.totalWin <= 0 || !spin.roundId) {
    return;
  }

  await assert.rejects(
    () => goldenTreeService.executeGamble("u2", spin.roundId, "Red"),
    (err) =>
      err.statusCode === 403 &&
      /gamble not available/i.test(String(err.message || "")),
  );
});

test("buy bonus creates 5 free spins session", async () => {
  wallet.clearStubForTests();
  roundManager.clearAllForTests();
  wallet.seedStubBalance("u3", 10000000);

  const purchase = await goldenTreeService.executeBuyBonus("u3", "Triple", 10000);
  assert.equal(purchase.cost, 3500000);
  assert.equal(purchase.freeSpinsRemaining, 5);
  assert.equal(purchase.resolvedType, "Triple");

  const spin1 = await goldenTreeService.executeSpin("u3", 10000);
  assert.equal(spin1.isFreeSpin, true);
  assert.equal(spin1.betAmount, 10000);
  assert.equal(spin1.freeSpinsRemaining, 4);
});

test("bet validation rejects out-of-range amounts", async () => {
  wallet.clearStubForTests();
  roundManager.clearAllForTests();
  await assert.rejects(
    () => goldenTreeService.executeSpin("u4", 9999),
    (err) => err.statusCode === 400,
  );
  const { BET_MAX } = require("../games/goldenTree/constants");
  await assert.rejects(
    () => goldenTreeService.executeSpin("u4", BET_MAX + 1),
    (err) => err.statusCode === 400,
  );
});

test("RTP probe — main game simulation (informational)", () => {
  // This is a regression guard for the current rule set, not an RTP target.
  // Economics tuning remains a separate game-design decision.
  const rounds = 20000;
  const bet = 10000;
  let totalReturned = 0;

  for (let i = 0; i < rounds; i += 1) {
    const { matrix, wildMultipliers } = generateSpin({ bonusMode: false });
    const { totalWin } = calculateWins(matrix, wildMultipliers, bet, {
      bonusMode: false,
    });
    totalReturned += totalWin;
  }

  const rtp = totalReturned / (rounds * bet);
  assert.ok(
    rtp > 0.9 && rtp < 1.8,
    `3+ any-row RTP sample ${rtp.toFixed(4)} out of expected sanity band`,
  );
});

test("jackpot roll — miss does not award", () => {
  const { JACKPOT_MULTIPLIER } = require("../games/goldenTree/constants");
  const miss = goldenTreeService.rollJackpot(10000, {
    isBonusSpin: false,
    rng: () => 1,
  });
  assert.equal(miss.jackpotHit, false);
  assert.equal(miss.jackpotAmount, 0);
  assert.ok(miss.meters);
  assert.equal(typeof miss.meters.spade, "number");
  assert.equal(JACKPOT_MULTIPLIER, 1000);
});

test("jackpot roll — hit awards bet × 1000", () => {
  const hit = goldenTreeService.rollJackpot(10000, {
    isBonusSpin: false,
    rng: () => 0,
  });
  assert.equal(hit.jackpotHit, true);
  assert.equal(hit.jackpotAmount, 10_000_000);
  assert.ok(hit.meters);
});

test("jackpot roll — disabled on bonus spins", () => {
  const bonus = goldenTreeService.rollJackpot(10000, {
    isBonusSpin: true,
    rng: () => 0,
  });
  assert.equal(bonus.jackpotHit, false);
  assert.equal(bonus.jackpotAmount, 0);
});

test("match-3 jackpot triggers at 3+ jackpot symbols", () => {
  const goldenTreeJackpot = require("../games/goldenTree/goldenTreeJackpot");
  const matrix = emptyMatrix(SYMBOLS.ORANGE);
  assert.equal(goldenTreeJackpot.isJackpotTriggered(matrix), false);
  matrix[0][0] = SYMBOLS.JACKPOT;
  matrix[1][1] = SYMBOLS.JACKPOT;
  assert.equal(goldenTreeJackpot.isJackpotTriggered(matrix), false);
  matrix[2][2] = SYMBOLS.JACKPOT;
  assert.equal(goldenTreeJackpot.isJackpotTriggered(matrix), true);
});

test("spin response includes jackpot fields", async () => {
  wallet.clearStubForTests();
  roundManager.clearAllForTests();
  wallet.seedStubBalance("u-jp", 500000);

  const result = await goldenTreeService.executeSpin("u-jp", 10000);
  assert.equal(typeof result.jackpotHit, "boolean");
  assert.equal(typeof result.jackpotAmount, "number");
  assert.ok(result.jackpotMeters);
  assert.equal(typeof result.jackpotMeters.club, "number");
  assert.equal(typeof result.jackpotMeters.spade, "number");
});
