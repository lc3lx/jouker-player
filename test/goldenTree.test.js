process.env.GOLDEN_TREE_WALLET_MODE = "stub";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  PAYLINES,
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

test("payline parser — left-to-right with wild substitution", () => {
  const symbols = [SYMBOLS.WILD, SYMBOLS.WILD, SYMBOLS.CHERRY, SYMBOLS.PINEAPPLE, SYMBOLS.PLUM];
  const match = matchPayline(symbols);
  assert.equal(match.count, 3);
  assert.equal(match.symbol, SYMBOLS.CHERRY);
});

test("seven pays from 2-of-a-kind", () => {
  const pay = basePayout(SYMBOLS.SEVEN, 2, 10000);
  assert.equal(pay, 2000);
});

test("wild multipliers add on line win", () => {
  const matrix = emptyMatrix();
  matrix[0][PAYLINES[0][0]] = SYMBOLS.CHERRY;
  matrix[1][PAYLINES[0][1]] = SYMBOLS.CHERRY;
  matrix[2][PAYLINES[0][2]] = SYMBOLS.CHERRY;

  const wildMults = { 0: 2, 1: 3 };
  matrix[0] = [SYMBOLS.WILD, SYMBOLS.WILD, SYMBOLS.WILD];
  matrix[1] = [SYMBOLS.WILD, SYMBOLS.WILD, SYMBOLS.WILD];

  const result = calculateWins(matrix, wildMults, 1);
  assert.ok(result.totalWin > 0);
  assert.equal(result.lineWins[0].wildMultiplier, 5);
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

test("gamble doubles or zeroes win", async () => {
  wallet.clearStubForTests();
  roundManager.clearAllForTests();
  wallet.seedStubBalance("u2", 500000);

  const spin = await goldenTreeService.executeSpin("u2", 10000);
  if (spin.totalWin <= 0 || !spin.gambleEligible) {
    return;
  }

  const before = await wallet.getBalance("u2");
  const gamble = await goldenTreeService.executeGamble(
    "u2",
    spin.roundId,
    "Red",
  );
  const after = await wallet.getBalance("u2");

  if (gamble.won) {
    assert.equal(gamble.currentWin, roundMoney(spin.totalWin * 2));
    assert.equal(after, roundMoney(before + spin.totalWin));
  } else {
    assert.equal(gamble.currentWin, 0);
    assert.equal(after, roundMoney(before - spin.totalWin));
  }
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
  await assert.rejects(
    () => goldenTreeService.executeSpin("u4", 40000001),
    (err) => err.statusCode === 400,
  );
});

test("RTP probe — main game simulation (informational)", () => {
  const rounds = 5000;
  const bet = 1;
  let totalReturned = 0;

  for (let i = 0; i < rounds; i += 1) {
    const { matrix, wildMultipliers } = generateSpin({ bonusMode: false });
    const { totalWin } = calculateWins(matrix, wildMultipliers, bet);
    totalReturned += totalWin;
  }

  const rtp = totalReturned / (rounds * bet);
  assert.ok(rtp > 0.3 && rtp < 1.5, `RTP sample ${rtp.toFixed(4)} out of sanity band`);
});
