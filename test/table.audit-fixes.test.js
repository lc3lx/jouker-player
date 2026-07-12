/**
 * Regression tests for the table-system audit fixes:
 *  1. Settlement forfeits the locked buy-in of a vacated human whose seat a bot played out.
 *  2. Poker boot refund releases waitingQueue locked buy-ins (not just seats/vacating).
 *  3. Poker join transaction re-validates duplicates after switching to another table.
 *  4. Queue-seated poker players receive a free seatPosition.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { InMemorySettlementHarness } = require("./helpers/inMemorySettlementHarness");

function thenable(resolver) {
  const chain = {
    populate: () => chain,
    session: () => chain,
    select: () => chain,
    sort: () => chain,
    lean: async () => resolver(),
    then: (resolve, reject) => Promise.resolve(resolver()).then(resolve, reject),
  };
  return chain;
}

// ─── 1. settlement forfeits vacated bot seats ────────────────────────────────

test("settlement forfeits locked buy-in of vacated human replaced by bot", async () => {
  const harness = new InMemorySettlementHarness();
  harness.installMocks();
  const walletLedger = require("../services/walletLedgerService");
  const origForfeit = walletLedger.forfeitTableSeatLock;
  const forfeits = [];
  walletLedger.forfeitTableSeatLock = async ({ userId, tableId, seatChips }) => {
    forfeits.push({ userId: String(userId), tableId: String(tableId), seatChips });
    const w = harness.wallets.get(String(userId));
    if (w) w.lockedBalance = Math.max(0, w.lockedBalance - seatChips);
    return seatChips;
  };

  try {
    const { settleGameOnFinish } = harness.loadGameSettlementService();
    const { tableId, gamePlayers } = harness.seedTrixTable({
      buyIn: 1000,
      humanSeats: 2,
      botSeats: 2,
    });

    // Seat 1's human vacated mid-game — engine converted them to a bot and
    // recorded vacatedFromUserId; the Mongo seat still holds the human's user id.
    const vacatedUid = String(gamePlayers[1].userId);
    gamePlayers[1].isBot = true;
    gamePlayers[1].vacatedFromUserId = vacatedUid;
    gamePlayers[1].userId = "bot_vacate_1";

    const before = harness.getWallet(vacatedUid);
    assert.equal(before.lockedBalance, 1000);
    const balanceBefore = before.balance;

    const result = await settleGameOnFinish({
      gameType: "trix",
      tableId,
      sessionId: crypto.randomUUID(),
      gameResult: { winnerIndex: 0, scores: [250, 80, 60, 40] },
      gamePlayers,
      rakePercent: 5,
    });

    assert.equal(result.success, true);
    assert.equal(forfeits.length, 1);
    assert.equal(forfeits[0].userId, vacatedUid);
    assert.equal(forfeits[0].seatChips, 1000);

    const after = harness.getWallet(vacatedUid);
    assert.equal(after.lockedBalance, 0, "vacated player's lock must be forfeited");
    assert.equal(after.balance, balanceBefore, "forfeit must not credit balance");
  } finally {
    walletLedger.forfeitTableSeatLock = origForfeit;
    harness.restoreMocks();
  }
});

// ─── 2. poker boot refund covers waitingQueue ────────────────────────────────

test("poker boot sanitizer refunds seats, vacating players AND queued players", async () => {
  const Table = require("../models/tableModel");
  const walletLedger = require("../services/walletLedgerService");

  const origFindById = Table.findById;
  const orig = {
    withMongoTransaction: walletLedger.withMongoTransaction,
    releaseTableSeatToBalance: walletLedger.releaseTableSeatToBalance,
  };

  const releases = [];
  walletLedger.withMongoTransaction = async (fn) => fn(null);
  walletLedger.releaseTableSeatToBalance = async ({ userId, seatChips, meta }) => {
    releases.push({ userId: String(userId), seatChips, reason: meta?.reason });
  };

  const tableDoc = {
    _id: "poker-boot-1",
    gameType: "poker",
    tableKind: "static",
    tableNumber: 7,
    status: "playing",
    seats: [
      { user: "seatA", chips: 5000 },
      { user: "seatB", chips: 3000 },
    ],
    vacatingPlayers: [
      { user: "vacC", chips: 2000, vacateUntil: new Date(Date.now() - 1000) },
    ],
    waitingQueue: [
      { user: "queueD", buyIn: 4000 },
      // Duplicate of a seated user must NOT be refunded twice.
      { user: "seatA", buyIn: 5000 },
    ],
    activeSettlementId: null,
    save: async function save() {
      return this;
    },
  };

  Table.findById = () => thenable(() => tableDoc);

  try {
    delete require.cache[require.resolve("../services/tableGcService")];
    const { sanitizePokerTableOnBoot } = require("../services/tableGcService");

    const result = await sanitizePokerTableOnBoot(tableDoc, null);
    assert.equal(result.action, "reset");

    const byUser = new Map(releases.map((r) => [r.userId, r]));
    assert.equal(byUser.get("seatA")?.seatChips, 5000);
    assert.equal(byUser.get("seatB")?.seatChips, 3000);
    assert.equal(byUser.get("vacC")?.seatChips, 2000);
    assert.equal(byUser.get("queueD")?.seatChips, 4000, "queued buy-in must be refunded");
    assert.equal(releases.length, 4, "seated user duplicated in queue must not double-refund");

    assert.equal(tableDoc.seats.length, 0);
    assert.equal(tableDoc.waitingQueue.length, 0);
    assert.equal(tableDoc.vacatingPlayers.length, 0);
  } finally {
    Table.findById = origFindById;
    walletLedger.withMongoTransaction = orig.withMongoTransaction;
    walletLedger.releaseTableSeatToBalance = orig.releaseTableSeatToBalance;
    delete require.cache[require.resolve("../services/tableGcService")];
  }
});

// ─── 3. poker join re-validates after table switch ───────────────────────────

async function withJoinTransactionMocks({ initialTable, switchedTable }, run) {
  const Table = require("../models/tableModel");
  const walletLedger = require("../services/walletLedgerService");
  const collusion = require("../services/pokerCollusionGuard");

  const orig = {
    findById: Table.findById,
    findOne: Table.findOne,
    transferToLocked: walletLedger.transferToLocked,
    assertNoCollusion: collusion.assertNoCollusionAtPublicTable,
  };

  const locks = [];
  Table.findById = (id) =>
    thenable(() => (String(id) === String(initialTable._id) ? initialTable : null));
  Table.findOne = () => thenable(() => switchedTable);
  walletLedger.transferToLocked = async ({ userId, amount }) => {
    locks.push({ userId: String(userId), amount });
  };
  collusion.assertNoCollusionAtPublicTable = async () => {};

  try {
    delete require.cache[require.resolve("../services/pokerTableAllocationService")];
    const { executePokerJoinTransaction } = require("../services/pokerTableAllocationService");
    await run({ executePokerJoinTransaction, locks });
  } finally {
    Table.findById = orig.findById;
    Table.findOne = orig.findOne;
    walletLedger.transferToLocked = orig.transferToLocked;
    collusion.assertNoCollusionAtPublicTable = orig.assertNoCollusion;
    delete require.cache[require.resolve("../services/pokerTableAllocationService")];
  }
}

function mkFullPokerTable(id, { withUserSeated = null, withUserQueued = null } = {}) {
  const seats = Array.from({ length: 9 }, (_, i) => ({
    user: `occupant_${id}_${i}`,
    chips: 1000,
    seatPosition: i,
  }));
  const table = {
    _id: id,
    gameType: "poker",
    tier: "beginner",
    tableNumber: 1,
    minBuyIn: 1000,
    maxBuyIn: 1000,
    capacity: 9,
    status: "waiting",
    seats,
    waitingQueue: [],
    save: async function save() {
      return this;
    },
  };
  if (withUserSeated) {
    table.seats = seats.slice(0, 8).concat([{ user: withUserSeated, chips: 1000, seatPosition: 8 }]);
    table.seats.pop();
    table.seats.push({ user: withUserSeated, chips: 1000, seatPosition: 8 });
  }
  if (withUserQueued) {
    table.waitingQueue.push({ user: withUserQueued, buyIn: 1000 });
  }
  return table;
}

test("poker join throws ALREADY_SEATED when switched table already seats the user", async () => {
  const userId = "racing-user";
  const initialTable = mkFullPokerTable("full-t1");
  const switchedTable = mkFullPokerTable("open-t2", { withUserSeated: userId });
  // Leave one seat free on the switched table so only the duplicate check can reject.
  switchedTable.seats = switchedTable.seats.slice(0, 8);
  switchedTable.seats[7] = { user: userId, chips: 1000, seatPosition: 7 };

  await withJoinTransactionMocks({ initialTable, switchedTable }, async ({ executePokerJoinTransaction, locks }) => {
    await assert.rejects(
      executePokerJoinTransaction({
        userId,
        playerId: "p1",
        buyIn: 1000,
        tableId: initialTable._id,
        session: null,
      }),
      /ALREADY_SEATED/
    );
    assert.equal(locks.length, 0, "no wallet lock may be taken on a duplicate join");
  });
});

test("poker join throws ALREADY_QUEUED when switched table already queues the user", async () => {
  const userId = "racing-user-2";
  const initialTable = mkFullPokerTable("full-t3");
  const switchedTable = mkFullPokerTable("open-t4", { withUserQueued: userId });
  switchedTable.seats = switchedTable.seats.slice(0, 8);

  await withJoinTransactionMocks({ initialTable, switchedTable }, async ({ executePokerJoinTransaction, locks }) => {
    await assert.rejects(
      executePokerJoinTransaction({
        userId,
        playerId: "p2",
        buyIn: 1000,
        tableId: initialTable._id,
        session: null,
      }),
      /ALREADY_QUEUED/
    );
    assert.equal(locks.length, 0);
  });
});

// ─── 4. queue-seated players get a seatPosition ──────────────────────────────

test("seatNextFromQueue assigns the next free seatPosition", async () => {
  const Table = require("../models/tableModel");
  const origFindById = Table.findById;

  const tableDoc = {
    _id: "queue-seat-1",
    gameType: "poker",
    capacity: 9,
    minBuyIn: 1000,
    seats: [
      { user: "a", chips: 1000, seatPosition: 0 },
      { user: "b", chips: 1000, seatPosition: 1 },
      { user: "c", chips: 1000, seatPosition: 3 },
    ],
    waitingQueue: [{ user: "queued-user", player: "pq", buyIn: 1000 }],
    save: async function save() {
      return this;
    },
  };
  Table.findById = () => thenable(() => tableDoc);

  try {
    const { seatNextFromQueue } = require("../services/pokerWaitingQueueService");
    const seated = await seatNextFromQueue({ session: null, tableId: tableDoc._id });
    assert.equal(seated, "queued-user");
    const newSeat = tableDoc.seats.find((s) => String(s.user) === "queued-user");
    assert.ok(newSeat, "queued player must be seated");
    assert.equal(newSeat.seatPosition, 2, "first free chair (2) must be assigned");
  } finally {
    Table.findById = origFindById;
  }
});
