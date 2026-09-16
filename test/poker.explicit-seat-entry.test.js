const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate the allocator from database connections and background game timers.
function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const Table = {};
let transfers = 0;
let creations = [];
stub('../models/tableModel', Table);
stub('../services/walletLedgerService', {
  withMongoTransaction: (fn) => fn({}),
  transferToLocked: async () => { transfers++; },
});
stub('../services/pokerWaitingQueueService', {
  enqueuePlayer: () => { throw new Error('Unexpected queue'); },
});
stub('../services/pokerCollusionGuard', {
  assertNoCollusionAtPublicTable: async () => {},
  registerSeatPresence: async () => {},
});
stub('../services/pokerTableGcService', { markTableActivity() {} });
stub('../sockets/pokerTableGameBridge', { getTableGameDebugSnapshot: () => null });
stub('../services/tableFactory', {
  createDynamicTable: async (args) => {
    creations.push(args);
    return { _id: 'overflow', ...args };
  },
});
const { joinPokerWithRetry, findAvailablePokerTable } =
  require('../services/pokerTableAllocationService');

test('explicit tenth seat fails without queueing, allocating, or locking coins', async () => {
  Table.findById = () => ({ session: async () => ({
    _id: 'full', gameType: 'poker', capacity: 9,
    minBuyIn: 1000, maxBuyIn: 5000, waitingQueue: [],
    seats: Array.from({ length: 9 }, (_, i) => ({ user: `human${i}`, seatPosition: i })),
  }) });
  Table.findOne = () => { throw new Error('Unexpected automatic routing'); };
  await assert.rejects(joinPokerWithRetry({
    userId: 'tenth', playerId: 'p10', buyIn: 1000,
    initialTableId: 'full', tier: 'beginner', seatIndex: 4, strictTable: true,
  }), /TABLE_FULL/);
  assert.equal(transfers, 0);
  assert.equal(creations.length, 0);
});

test('overflow reuses a public room with exactly matching stakes', async () => {
  let filter;
  const room = { _id: 'shared-overflow' };
  Table.findOne = (query) => {
    filter = query;
    return { sort: () => Promise.resolve(room) };
  };
  const result = await findAvailablePokerTable('beginner', 1000, null, {
    excludeIds: ['full'], minBuyIn: 1000, maxBuyIn: 5000,
    smallBlind: 25, bigBlind: 50,
  });
  assert.equal(result, room);
  assert.equal(filter.maxBuyIn, 5000);
  assert.equal(filter.smallBlind, 25);
  assert.equal(filter.bigBlind, 50);
  assert.deepEqual(filter.isPrivate, { $ne: true });
  assert.equal(filter.owner, null);
  assert.deepEqual(filter._id, { $nin: ['full'] });
  assert.equal(creations.length, 0);
});

test('new overflow preserves the buy-in range, blinds, and nine-seat capacity', async () => {
  let reads = 0;
  Table.findOne = () => ({ sort: () => ++reads === 1
    ? Promise.resolve(null)
    : { select: () => ({ session: async () => ({ tableNumber: 12 }) }) },
  });
  const result = await findAvailablePokerTable('beginner', 1000, null, {
    minBuyIn: 1000, maxBuyIn: 5000, smallBlind: 25, bigBlind: 50,
  });
  assert.equal(result.tableNumber, 13);
  assert.equal(result.capacity, 9);
  assert.equal(result.minBuyIn, 1000);
  assert.equal(result.maxBuyIn, 5000);
  assert.equal(result.smallBlind, 25);
  assert.equal(result.bigBlind, 50);
});
