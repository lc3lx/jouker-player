/**
 * Poseidon Jackpot — backend unit + integration tests.
 *
 * Run: node --test test/poseidonJackpot.test.js
 */

process.env.POSEIDON_WALLET_MODE = "stub";

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  pickWeightedPrize,
  buildMatchThreeLayout,
  resolveFirstTriple,
} = require("../games/poseidon/jackpot/jackpotSelector");

const {
  countJackpotSymbols,
  isJackpotTriggered,
  createJackpotRound,
  recoverJackpotRound,
  revealJackpotCard,
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

function fixedRng(value) {
  return () => value;
}

beforeEach(() => {
  _clearStubForTests();
  roundManager.clearAllForTests();
  wallet.clearStubForTests();
});

describe("buildMatchThreeLayout", () => {
  test("returns exactly 9 cards", () => {
    assert.equal(buildMatchThreeLayout().length, JACKPOT_CARD_COUNT);
  });

  test("has exactly 3 of each prize tier", () => {
    const cards = buildMatchThreeLayout();
    const counts = { super10m: 0, mega50m: 0, grand100m: 0 };
    for (const c of cards) counts[c.prize]++;
    assert.equal(counts.super10m, 3);
    assert.equal(counts.mega50m, 3);
    assert.equal(counts.grand100m, 3);
  });

  test("indices are 0..8", () => {
    const indices = buildMatchThreeLayout().map((c) => c.index).sort((a, b) => a - b);
    assert.deepEqual(indices, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("resolveFirstTriple", () => {
  test("returns null until 3 of same type revealed", () => {
    const cards = buildMatchThreeLayout();
    const first = cards.find((c) => c.prize === "super10m");
    const second = cards.find((c) => c.prize === "super10m" && c.index !== first.index);
    assert.equal(resolveFirstTriple(cards, [first.index]), null);
    assert.equal(resolveFirstTriple(cards, [first.index, second.index]), null);
  });

  test("returns prize when 3rd match revealed", () => {
    const cards = buildMatchThreeLayout();
    const supers = cards.filter((c) => c.prize === "super10m").map((c) => c.index);
    const result = resolveFirstTriple(cards, supers);
    assert.equal(result.type, "super10m");
    assert.equal(result.amount, 10_000_000);
  });
});

describe("createJackpotRound", () => {
  test("creates round with hidden cards", async () => {
    const data = await createJackpotRound({ spinId: "spin-1", userId: "user-jp-1" });
    assert.ok(data.roundId);
    assert.equal(data.spinId, "spin-1");
    assert.equal(data.prizeType, null);
    assert.equal(data.cards.length, JACKPOT_CARD_COUNT);
    assert.ok(data.cards.every((c) => c.prize === undefined));
    assert.equal(data.status, JACKPOT_STATUS.PENDING);
  });
});

describe("revealJackpotCard", () => {
  test("reveals one card and returns its face", async () => {
    const created = await createJackpotRound({ spinId: "s1", userId: "u1" });
    const res = await revealJackpotCard(created.roundId, "u1", 0);
    assert.equal(res.card.index, 0);
    assert.ok(["super10m", "mega50m", "grand100m"].includes(res.card.prize));
    assert.equal(res.matched, false);
  });

  test("game ends when 3 of same type are revealed", async () => {
    const created = await createJackpotRound({ spinId: "s1", userId: "u2" });
    const stored = _getStubRounds().get(created.roundId);
    const targets = stored.cards
      .filter((c) => c.prize === "mega50m")
      .map((c) => c.index);

    let last;
    for (const idx of targets) {
      last = await revealJackpotCard(created.roundId, "u2", idx);
    }
    assert.equal(last.gameOver, true);
    assert.equal(last.matched, true);
    assert.equal(last.prizeType, "mega50m");
    assert.equal(last.prizeAmount, 50_000_000);
  });
});

describe("settleJackpotRound", () => {
  async function revealTriple(roundId, userId, prizeType) {
    const stored = _getStubRounds().get(roundId);
    const indices = stored.cards.filter((c) => c.prize === prizeType).map((c) => c.index);
    for (const idx of indices) {
      await revealJackpotCard(roundId, userId, idx);
    }
  }

  test("credits wallet after triple match", async () => {
    const created = await createJackpotRound({ spinId: "s-grand", userId: "user-s1" });
    wallet.seedStubBalance("user-s1", 1_000_000);
    const before = await wallet.getBalance("user-s1");

    await revealTriple(created.roundId, "user-s1", "grand100m");
    const result = await settleJackpotRound(created.roundId, "user-s1");

    assert.equal(result.settled, true);
    assert.equal(result.prizeAmount, 100_000_000);
    assert.equal(result.balance, before + 100_000_000);
  });

  test("rejects settle before triple match", async () => {
    const created = await createJackpotRound({ spinId: "s-early", userId: "user-s2" });
    await revealJackpotCard(created.roundId, "user-s2", 0);
    await assert.rejects(
      () => settleJackpotRound(created.roundId, "user-s2"),
      /not ready/
    );
  });

  test("idempotency — calling twice credits only once", async () => {
    const created = await createJackpotRound({ spinId: "s-idem", userId: "user-s3" });
    wallet.seedStubBalance("user-s3", 500_000);
    await revealTriple(created.roundId, "user-s3", "super10m");

    const first = await settleJackpotRound(created.roundId, "user-s3");
    const second = await settleJackpotRound(created.roundId, "user-s3");

    assert.equal(first.settled, true);
    assert.equal(second.alreadySettled, true);
    assert.equal(second.balance, first.balance);
  });
});

describe("executeSpin jackpot integration", () => {
  test("spin result includes jackpotGame when triggered", async () => {
    wallet.seedStubBalance("user-jp-spin1", 5_000_000);
    const res = await poseidonService.executeSpin("user-jp-spin1", 10000);
    assert.ok("jackpotGame" in res);
    if (res.jackpotGame !== null) {
      assert.equal(res.jackpotGame.cards.length, JACKPOT_CARD_COUNT);
    }
  });
});
