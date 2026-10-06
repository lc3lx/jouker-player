process.env.NODE_ENV = "test";
process.env.POSEIDON_WALLET_MODE = "stub";
process.env.ZENOBIA_WALLET_MODE = "stub";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createOperationRng, newOperationSeed } = require("../games/utils/operationRng");
const operation = require("../games/utils/slotOperation");
const rtpTracker = require("../games/utils/rtpTracker");
const poseidonEngine = require("../games/poseidon/spinEngine");
const poseidonService = require("../games/poseidon/poseidonService");
const poseidonWallet = require("../games/poseidon/poseidonWalletAdapter");
const poseidonRounds = require("../games/poseidon/roundManager");
const jackpotService = require("../games/poseidon/jackpot/jackpotService");
const JackpotRound = require("../models/poseidonJackpotRoundModel");
const sweeper = require("../services/slotJackpotSweeper");
const { dropJackpotDeletionTtl } = require("../services/slotProductionSchemaService");

// --- seeded operation RNG -----------------------------------------------------

test("operation RNG is deterministic per seed and uniform in [0, 1)", () => {
  const a = createOperationRng("seed-a");
  const b = createOperationRng("seed-a");
  const c = createOperationRng("seed-b");
  const seqA = Array.from({ length: 50 }, () => a());
  assert.deepEqual(seqA, Array.from({ length: 50 }, () => b()));
  assert.notDeepEqual(seqA, Array.from({ length: 50 }, () => c()));
  const big = createOperationRng(newOperationSeed());
  let sum = 0;
  for (let i = 0; i < 20000; i += 1) {
    const v = big();
    assert.ok(v >= 0 && v < 1);
    sum += v;
  }
  assert.ok(Math.abs(sum / 20000 - 0.5) < 0.02);
});

test("a Mongo transaction retry replays the same outcome instead of re-rolling", async () => {
  const ledger = require("../services/walletLedgerService");
  const original = ledger.withMongoTransaction;
  const attempts = [];
  // Simulate a TransientTransactionError: the callback runs twice, the second
  // attempt commits.
  ledger.withMongoTransaction = async (work) => {
    await work({ attempt: 1 });
    return work({ attempt: 2 });
  };
  const wallet = { MODE: "mongo", withUserLock: (_user, fn) => fn() };
  const manager = { getBonusSession: () => null, replaceBonusSession: () => {} };
  const runOnce = () => operation.run(
    { game: "retry-test", userId: "u-retry", wallet, manager, modelName: "../test/fixtures/fakeSlotSessionModel", input: ["spin"] },
    async () => {
      const draw = operation.rng();
      const values = [draw(), draw(), draw()];
      attempts.push(values);
      return values;
    },
  );
  try {
    const first = await runOnce();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1]);
    assert.deepEqual(first, attempts[1]);
    const second = await runOnce();
    assert.notDeepEqual(second, first, "each operation draws a fresh seed");
  } finally {
    ledger.withMongoTransaction = original;
  }
});

test("Poseidon spins draw from the operation RNG and leave no per-player history", async () => {
  operation.clearForTests();
  poseidonRounds.clearAllForTests();
  poseidonWallet.clearStubForTests();
  rtpTracker._clearForTests();
  poseidonWallet.seedStubBalance("p0-player", 1e9);
  const original = poseidonEngine.resolveSpin;
  const seen = [];
  poseidonEngine.resolveSpin = (opts) => {
    seen.push(opts.rng);
    return original(opts);
  };
  try {
    await poseidonService.executeSpin("p0-player", 10000);
    await poseidonService.executeSpin("p0-player", 10000);
  } finally {
    poseidonEngine.resolveSpin = original;
  }
  assert.equal(seen.length, 2);
  assert.equal(typeof seen[0], "function");
  assert.notEqual(seen[0], seen[1]);
  assert.equal(rtpTracker.getPlayerRollingRtp("p0-player").spins, 0);
});

// --- jackpot: never deleted unpaid, abandoned rounds are paid by the server ---

test("jackpot rounds are only purged after settlement, never by reveal deadline", () => {
  const indexes = JackpotRound.schema.indexes();
  const ttl = indexes.filter(([, options]) => options?.expireAfterSeconds != null);
  assert.equal(ttl.length, 1);
  assert.deepEqual(Object.keys(ttl[0][0]), ["purgeAt"]);
  assert.equal(JackpotRound.schema.path("expiresAt").options.index, undefined);
});

test("boot migration drops only the old expiresAt TTL index", async () => {
  const dropped = [];
  const Model = {
    collection: {
      indexes: async () => [
        { name: "_id_", key: { _id: 1 } },
        { name: "expiresAt_1", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
        { name: "status_1_expiresAt_1", key: { status: 1, expiresAt: 1 } },
        { name: "purgeAt_1", key: { purgeAt: 1 }, expireAfterSeconds: 0 },
      ],
      dropIndex: async (name) => { dropped.push(name); },
    },
  };
  await dropJackpotDeletionTtl(Model);
  assert.deepEqual(dropped, ["expiresAt_1"]);
});

async function staleRound(userId, { game = "poseidon", bet = 10000, reveal = [] } = {}) {
  const created = await jackpotService.createJackpotRound({ spinId: `spin-${userId}`, userId, betAmount: bet, game });
  for (const idx of reveal) await jackpotService.revealJackpotCard(created.roundId, userId, idx);
  const rounds = jackpotService._getStubRounds();
  rounds.set(created.roundId, { ...rounds.get(created.roundId), expiresAt: new Date(Date.now() - 1000) });
  return created.roundId;
}

test("the sweeper pays an abandoned jackpot exactly once", async () => {
  jackpotService._clearStubForTests();
  poseidonWallet.clearStubForTests();
  poseidonWallet.seedStubBalance("jp-abandoned", 0);
  const roundId = await staleRound("jp-abandoned");
  // A fresh round (deadline not reached) must be left for the player.
  const fresh = await jackpotService.createJackpotRound({ spinId: "s2", userId: "jp-abandoned", betAmount: 10000 });

  const first = await sweeper.sweepOnce();
  assert.deepEqual({ claimed: first.claimed, resolved: first.resolved, failed: first.failed }, { claimed: 1, resolved: 1, failed: 0 });
  const round = jackpotService._getStubRounds().get(roundId);
  assert.equal(round.status, "settled");
  assert.ok([1_000_000, 5_000_000, 10_000_000].includes(round.prizeAmount));
  assert.ok(round.purgeAt instanceof Date && round.purgeAt > new Date());
  assert.equal(await poseidonWallet.getBalance("jp-abandoned"), round.prizeAmount);

  const second = await sweeper.sweepOnce();
  assert.equal(second.claimed, 0);
  assert.equal(await poseidonWallet.getBalance("jp-abandoned"), round.prizeAmount);
  assert.equal(jackpotService._getStubRounds().get(fresh.roundId).status, "pending");
});

test("a half-scratched round resolves to the first triple in reveal order", async () => {
  jackpotService._clearStubForTests();
  poseidonWallet.clearStubForTests();
  poseidonWallet.seedStubBalance("jp-half", 0);
  const roundId = await staleRound("jp-half", { reveal: [8, 7] });
  await sweeper.sweepOnce();
  const round = jackpotService._getStubRounds().get(roundId);
  assert.equal(round.status, "settled");
  // Replay: the player's two cards first, then index order.
  const order = [8, 7, ...[0, 1, 2, 3, 4, 5, 6]];
  const counts = new Map();
  let expected = null;
  for (const idx of order) {
    const card = round.cards.find((c) => c.index === idx);
    counts.set(card.prize, (counts.get(card.prize) || 0) + 1);
    if (counts.get(card.prize) === 3) { expected = card; break; }
  }
  assert.equal(round.prizeType, expected.prize);
  assert.equal(round.prizeAmount, expected.amount);
});

test("pending rounds are listed per player and game, settled ones are not", async () => {
  jackpotService._clearStubForTests();
  const open = await jackpotService.createJackpotRound({ spinId: "a", userId: "jp-list", betAmount: 10000, game: "zenobia" });
  await jackpotService.createJackpotRound({ spinId: "b", userId: "jp-list", betAmount: 10000, game: "king-arth" });
  await jackpotService.createJackpotRound({ spinId: "c", userId: "someone-else", betAmount: 10000, game: "zenobia" });
  const list = await jackpotService.listPendingRounds("jp-list", "zenobia");
  assert.deepEqual(list.map((r) => r.roundId), [open.roundId]);
  assert.ok(list[0].cards.every((c) => c.prize === undefined), "unrevealed prizes stay hidden");
});
