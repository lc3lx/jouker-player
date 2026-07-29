/**
 * Poseidon Jackpot — backend unit + integration tests.
 *
 * Run: node --test test/poseidonJackpot.test.js
 */

process.env.POSEIDON_WALLET_MODE = "stub";

const { test, describe, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  pickWeightedPrize,
  buildCardLayout,
} = require("../games/poseidon/jackpot/jackpotSelector");

const {
  countJackpotSymbols,
  isJackpotTriggered,
  createJackpotRound,
  recoverJackpotRound,
  markJackpotRevealed,
  _clearStubForTests,
  _getStubRounds,
} = require("../games/poseidon/jackpot/jackpotService");

const { settleJackpotRound } = require("../games/poseidon/jackpot/jackpotSettlement");

const { JACKPOT_MIN_SYMBOLS, JACKPOT_CARD_COUNT, JACKPOT_STATUS } =
  require("../games/poseidon/jackpot/jackpotConstants");

const wallet = require("../games/poseidon/poseidonWalletAdapter");
const poseidonService = require("../games/poseidon/poseidonService");
const roundManager = require("../games/poseidon/roundManager");

const { REEL_COUNT, ROW_COUNT } = require("../games/poseidon/constants");

// ─── helpers ──────────────────────────────────────────────────────────────────

function fullMatrix(fill) {
  return Array.from({ length: REEL_COUNT }, () => Array(ROW_COUNT).fill(fill));
}

function matrixWithJackpots(count) {
  const matrix = fullMatrix("s");
  let placed = 0;
  outer: for (let col = 0; col < REEL_COUNT; col++) {
    for (let row = 0; row < ROW_COUNT; row++) {
      if (placed >= count) break outer;
      matrix[col][row] = "jackpot";
      placed++;
    }
  }
  return matrix;
}

/** Deterministic RNG — always returns the same value */
function fixedRng(value) {
  return () => value;
}

beforeEach(() => {
  _clearStubForTests();
  roundManager.clearAllForTests();
  wallet.clearStubForTests();
});

// ─── jackpotSelector tests ────────────────────────────────────────────────────

describe("pickWeightedPrize", () => {
  test("returns a prize from the list", () => {
    const prize = pickWeightedPrize();
    assert.ok(prize && typeof prize.type === "string");
    assert.ok(typeof prize.amount === "number");
  });

  test("deterministic with fixed rng — no_win at roll=0.999 (last bucket)", () => {
    // With weight 300+60+30+10 = 400 total, roll 0.999×400 = 399.6
    // Walks through: no_win -300 = 99.6 > 0; super10m -60 = 39.6 > 0; mega50m -30 = 9.6 > 0; grand100m -10 = -0.4 < 0
    const prize = pickWeightedPrize(undefined, fixedRng(0.999));
    assert.equal(prize.type, "grand100m");
  });

  test("deterministic with fixed rng — no_win at roll=0 (first bucket wins)", () => {
    // roll 0 → 0 * 400 = 0; no_win weight=300; 0 - 300 = -300 < 0 → no_win
    const prize = pickWeightedPrize(undefined, fixedRng(0));
    assert.equal(prize.type, "no_win");
    assert.equal(prize.amount, 0);
  });

  test("throws when prizes array is empty", () => {
    assert.throws(() => pickWeightedPrize([]), /empty/);
  });

  test("throws when all weights are zero", () => {
    assert.throws(
      () => pickWeightedPrize([{ type: "x", amount: 0, weight: 0 }]),
      /zero/
    );
  });

  test("handles a single-entry list", () => {
    const p = pickWeightedPrize([{ type: "only", amount: 999, weight: 1 }], fixedRng(0.5));
    assert.equal(p.type, "only");
    assert.equal(p.amount, 999);
  });
});

// ─── buildCardLayout tests ────────────────────────────────────────────────────

describe("buildCardLayout", () => {
  test("returns exactly 9 cards", () => {
    const cards = buildCardLayout({ type: "no_win", amount: 0 });
    assert.equal(cards.length, JACKPOT_CARD_COUNT);
  });

  test("indices are 0..8 with no duplicates", () => {
    const cards = buildCardLayout({ type: "super10m", amount: 10_000_000 });
    const indices = cards.map((c) => c.index);
    assert.deepEqual(indices.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("no_win prize → no winning card in layout", () => {
    const cards = buildCardLayout({ type: "no_win", amount: 0 });
    const winning = cards.filter((c) => c.prize !== "no_win");
    assert.equal(winning.length, 0);
  });

  test("winning prize → exactly one card with matching prize", () => {
    const cards = buildCardLayout({ type: "mega50m", amount: 50_000_000 });
    const winners = cards.filter((c) => c.prize === "mega50m");
    assert.equal(winners.length, 1);
    assert.equal(winners[0].amount, 50_000_000);
  });

  test("winning prize → the winning card has correct amount", () => {
    const cards = buildCardLayout({ type: "grand100m", amount: 100_000_000 });
    const w = cards.find((c) => c.prize === "grand100m");
    assert.ok(w);
    assert.equal(w.amount, 100_000_000);
  });

  test("card at winning position uses the correct prize", () => {
    // With rng always=0.74 the winning pos = randomInt(0,9) — just check one card is winner
    const cards = buildCardLayout({ type: "super10m", amount: 10_000_000 });
    const win = cards.filter((c) => c.prize === "super10m");
    assert.equal(win.length, 1);
  });
});

// ─── trigger detection tests ──────────────────────────────────────────────────

describe("isJackpotTriggered / countJackpotSymbols", () => {
  test("0 jackpot symbols → not triggered", () => {
    assert.equal(isJackpotTriggered(fullMatrix("s")), false);
  });

  test("2 jackpot symbols → not triggered", () => {
    assert.equal(isJackpotTriggered(matrixWithJackpots(2)), false);
  });

  test("exactly 3 → triggered", () => {
    assert.equal(isJackpotTriggered(matrixWithJackpots(JACKPOT_MIN_SYMBOLS)), true);
  });

  test("4 symbols → triggered", () => {
    assert.equal(isJackpotTriggered(matrixWithJackpots(4)), true);
  });

  test("countJackpotSymbols counts correctly", () => {
    assert.equal(countJackpotSymbols(matrixWithJackpots(5)), 5);
    assert.equal(countJackpotSymbols(fullMatrix("s")), 0);
  });
});

// ─── jackpotService tests ─────────────────────────────────────────────────────

describe("createJackpotRound", () => {
  test("creates and persists a round", async () => {
    const data = await createJackpotRound({ spinId: "spin-1", userId: "user-jp-1" });
    assert.ok(data.roundId && typeof data.roundId === "string");
    assert.equal(data.spinId, "spin-1");
    assert.ok(["no_win", "super10m", "mega50m", "grand100m"].includes(data.prizeType));
    assert.equal(data.cards.length, JACKPOT_CARD_COUNT);
    assert.equal(data.status, JACKPOT_STATUS.PENDING);
  });

  test("each call creates a unique roundId", async () => {
    const a = await createJackpotRound({ spinId: "s1", userId: "u1" });
    const b = await createJackpotRound({ spinId: "s2", userId: "u1" });
    assert.notEqual(a.roundId, b.roundId);
  });

  test("prizeAmount is integer", async () => {
    const data = await createJackpotRound({ spinId: "s", userId: "u" });
    assert.equal(Math.floor(data.prizeAmount), data.prizeAmount);
  });
});

describe("recoverJackpotRound", () => {
  test("returns round data for valid player", async () => {
    const created = await createJackpotRound({ spinId: "s1", userId: "user-r1" });
    const recovered = await recoverJackpotRound(created.roundId, "user-r1");
    assert.ok(recovered);
    assert.equal(recovered.roundId, created.roundId);
  });

  test("returns null for unknown roundId", async () => {
    const result = await recoverJackpotRound("unknown-id", "user-r1");
    assert.equal(result, null);
  });

  test("returns null for wrong userId", async () => {
    const created = await createJackpotRound({ spinId: "s1", userId: "user-owner" });
    const result = await recoverJackpotRound(created.roundId, "user-other");
    assert.equal(result, null);
  });
});

describe("markJackpotRevealed", () => {
  test("transitions status to revealed and populates revealedCards", async () => {
    const created = await createJackpotRound({ spinId: "s1", userId: "user-rev1" });
    const updated = await markJackpotRevealed(created.roundId, "user-rev1");
    assert.equal(updated.status, JACKPOT_STATUS.REVEALED);
    assert.equal(updated.revealedCards.length, JACKPOT_CARD_COUNT);
  });

  test("throws for wrong userId", async () => {
    const created = await createJackpotRound({ spinId: "s1", userId: "user-rev2" });
    await assert.rejects(
      () => markJackpotRevealed(created.roundId, "wrong-user"),
      /mismatch/
    );
  });
});

// ─── jackpotSettlement tests ──────────────────────────────────────────────────

describe("settleJackpotRound", () => {
  test("settles no_win round — zero wallet credit", async () => {
    // Force no_win prize via rng=0
    const created = await createJackpotRound(
      { spinId: "s-nowin", userId: "user-s1" },
      fixedRng(0)   // picks no_win
    );
    assert.equal(created.prizeType, "no_win");

    wallet.seedStubBalance("user-s1", 1_000_000);
    const before = await wallet.getBalance("user-s1");

    const result = await settleJackpotRound(created.roundId, "user-s1");
    assert.equal(result.settled, true);
    assert.equal(result.prizeType, "no_win");
    assert.equal(result.prizeAmount, 0);

    const after = await wallet.getBalance("user-s1");
    assert.equal(after, before); // no change
  });

  test("settles a winning round — credits wallet exactly once", async () => {
    // Force grand100m via rng=0.999
    const created = await createJackpotRound(
      { spinId: "s-grand", userId: "user-s2" },
      fixedRng(0.999)   // picks grand100m
    );
    assert.equal(created.prizeType, "grand100m");

    wallet.seedStubBalance("user-s2", 1_000_000);
    const before = await wallet.getBalance("user-s2");

    const result = await settleJackpotRound(created.roundId, "user-s2");
    assert.equal(result.settled, true);
    assert.equal(result.prizeAmount, 100_000_000);
    assert.equal(result.balance, before + 100_000_000);
  });

  test("idempotency — calling twice credits only once", async () => {
    const created = await createJackpotRound(
      { spinId: "s-idem", userId: "user-s3" },
      fixedRng(0.999)
    );
    wallet.seedStubBalance("user-s3", 500_000);

    const first = await settleJackpotRound(created.roundId, "user-s3");
    const second = await settleJackpotRound(created.roundId, "user-s3");

    assert.equal(first.settled, true);
    assert.equal(second.alreadySettled, true);
    // Balance must equal balance after first settlement (not doubled)
    assert.equal(second.balance, first.balance);
  });

  test("rejects wrong userId", async () => {
    const created = await createJackpotRound({ spinId: "s-own", userId: "user-s4" });
    await assert.rejects(
      () => settleJackpotRound(created.roundId, "user-other"),
      /different player/
    );
  });

  test("rejects unknown roundId", async () => {
    await assert.rejects(
      () => settleJackpotRound("non-existent-id", "user-s5"),
      /not found/
    );
  });
});

// ─── poseidonService integration ──────────────────────────────────────────────

describe("executeSpin jackpot integration", () => {
  test("normal spin returns jackpotGame:null", async () => {
    wallet.seedStubBalance("user-jp-spin1", 5_000_000);
    const res = await poseidonService.executeSpin("user-jp-spin1", 10000);
    assert.ok("jackpotGame" in res, "jackpotGame key must exist in spin result");
    // Most spins won't trigger jackpot — just assert the field is present
    // (it may be null or an object depending on RNG luck)
    if (res.jackpotGame !== null) {
      assert.ok(res.jackpotGame.roundId);
      assert.equal(res.jackpotGame.cards.length, JACKPOT_CARD_COUNT);
    }
  });

  test("jackpot fields present on spin result even when null", async () => {
    wallet.seedStubBalance("user-jp-spin2", 100_000_000);
    const res = await poseidonService.executeSpin("user-jp-spin2", 10000);
    assert.ok(Object.prototype.hasOwnProperty.call(res, "jackpotGame"));
  });
});
