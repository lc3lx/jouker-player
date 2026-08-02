/**
 * King Arth jackpot — engine trigger + shared match-3 round wiring.
 *
 * Run: node --test test/kingArthJackpot.test.js
 */

process.env.POSEIDON_WALLET_MODE = "stub";

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const DiceEngine = require("../games/dice/DiceEngine");
const kingArthJackpot = require("../games/dice/kingArthJackpot");
const {
  _clearStubForTests,
} = require("../games/poseidon/jackpot/jackpotService");

function fullGrid(fill) {
  return Array.from({ length: DiceEngine.COLS }, () =>
    Array(DiceEngine.ROWS).fill(fill)
  );
}

function gridWithJackpots(count) {
  const grid = fullGrid(0);
  let placed = 0;
  outer: for (let c = 0; c < DiceEngine.COLS; c++) {
    for (let r = 0; r < DiceEngine.ROWS; r++) {
      if (placed >= count) break outer;
      grid[c][r] = DiceEngine.JACKPOT;
      placed++;
    }
  }
  return grid;
}

beforeEach(() => {
  _clearStubForTests();
});

describe("DiceEngine jackpot symbol", () => {
  test("JACKPOT index is 17 and not a multiplier", () => {
    assert.equal(DiceEngine.JACKPOT, 17);
    assert.equal(DiceEngine.isJackpot(17), true);
    assert.equal(DiceEngine.isJackpot(8), false);
  });

  test("countJackpotSymbols counts only JACKPOT cells", () => {
    assert.equal(DiceEngine.countJackpotSymbols(gridWithJackpots(0)), 0);
    assert.equal(DiceEngine.countJackpotSymbols(gridWithJackpots(2)), 2);
    assert.equal(DiceEngine.countJackpotSymbols(gridWithJackpots(3)), 3);
  });

  test("spin result includes jackpotSymbolCount and jackpotTriggered", () => {
    const outcome = DiceEngine.spin(10000, {
      serverSeed: "seed-a",
      clientSeed: "client-a",
      nonce: "1",
    });
    assert.equal(typeof outcome.jackpotSymbolCount, "number");
    assert.equal(
      outcome.jackpotTriggered,
      outcome.jackpotSymbolCount >= DiceEngine.JACKPOT_MIN_SYMBOLS
    );
  });
});

describe("kingArthJackpot trigger + round", () => {
  test("isJackpotTriggered requires 3+ symbols", () => {
    assert.equal(kingArthJackpot.isJackpotTriggered(gridWithJackpots(2)), false);
    assert.equal(kingArthJackpot.isJackpotTriggered(gridWithJackpots(3)), true);
  });

  test("create/reveal/settle match-3 flow", async () => {
    const game = await kingArthJackpot.createRoundForSpin({
      spinId: "spin-1",
      userId: "user-1",
    });
    assert.ok(game.roundId);
    assert.equal(game.cards.length, 9);
    assert.equal(game.status, "pending");

    // Reveal until game over
    let last = null;
    for (let i = 0; i < 9; i++) {
      last = await kingArthJackpot.revealCard(game.roundId, "user-1", i);
      if (last.gameOver) break;
    }
    assert.ok(last);
    assert.equal(last.gameOver, true);
    assert.ok(["super10m", "mega50m", "grand100m"].includes(last.prizeType));

    const settled = await kingArthJackpot.settleRound(game.roundId, "user-1");
    assert.equal(settled.settled, true);
    assert.equal(settled.prizeType, last.prizeType);
    assert.ok(settled.prizeAmount > 0);
  });
});
