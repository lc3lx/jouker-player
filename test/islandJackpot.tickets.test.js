const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withHarness, ISLAND_HANDS } = require('./helpers/islandJackpotHarness');
const tickets = require('../services/islandTicketService');
const Ticket = require('../models/islandTicketModel');
const Member = require('../models/islandMemberModel');
const Pool = require('../models/islandPoolModel');

test('round tickets: cutoff, single use, automatic renewal, cancellation and insufficient funds', async () => {
  await withHarness(async h => {
    await h.configurePool({ entryFee: 10000, minTriggerAmount: 1, poolBalance: 100000 });
    const user = await h.createUser({ balance: 35000 });
    const beforePurchase = Date.now() - 1000;
    await h.joinMember(user);
    const tableId = String(h.tableId);
    const start = (handId, startedAt = Date.now()) => tickets.prepareHand({
      tableId, handId, startedAt, userIds: [user._id],
    });
    await start('already-started', beforePurchase);
    assert.equal(await Ticket.countDocuments({ handId: 'already-started' }), 0);
    assert.equal((await tickets.personalStatus(user._id, tableId)).nextHandPurchased, true);

    await start('paid-hand');
    await start('paid-hand');
    assert.equal(await Ticket.countDocuments({ handId: 'paid-hand' }), 1);
    assert.equal(await h.getWalletBalance(user._id), 25000);
    await start('unpaid-hand');
    assert.equal(await Ticket.countDocuments({ handId: 'unpaid-hand' }), 0);
    const payout = await h.service.reservePayoutForHand({
      tableId, handId: 'unpaid-hand', gameType: 'poker', reason: 'showdown',
      seats: [h.buildSeat(user, 'royalFlush')], community: ISLAND_HANDS.royalFlush.community,
    });
    assert.equal(payout.reason, 'no_qualifiers');

    await tickets.setAutoBuy(user._id, tableId, true);
    await start('auto-1');
    assert.equal(await h.getWalletBalance(user._id), 15000);
    await tickets.setAutoBuy(user._id, tableId, false);
    await start('auto-off');
    assert.equal(await h.getWalletBalance(user._id), 15000);
    await tickets.setAutoBuy(user._id, tableId, true);
    await Promise.all([start('auto-2'), start('auto-2')]);
    assert.equal(await Ticket.countDocuments({ handId: 'auto-2' }), 1);
    assert.equal(await h.getWalletBalance(user._id), 5000);
    await start('insufficient');
    assert.equal(await Ticket.countDocuments({ handId: 'insufficient' }), 0);
    assert.equal(await h.getWalletBalance(user._id), 5000);
    assert.equal((await tickets.personalStatus(user._id, tableId)).autoBuy, false);
  });
});

test('prepaid plus auto costs once, retries cannot buy another ticket, outsiders cannot subscribe', async () => {
  await withHarness(async h => {
    await h.configurePool({ entryFee: 10000 });
    const user = await h.createUser({ balance: 100000 });
    const outsider = await h.createUser();
    await h.joinMember(user, { idempotencyKey: 'buy-once' });
    const tableId = String(h.tableId);
    await assert.rejects(() => tickets.buyNext(outsider._id, tableId, 'outsider'), /Sit at this poker table/);
    await tickets.setAutoBuy(user._id, tableId, true);
    await Pool.updateOne({ key: 'default' }, { $set: { enabled: false } });
    await tickets.prepareHand({ tableId, handId: 'disabled', startedAt: Date.now(), userIds: [user._id] });
    assert.equal(await Ticket.countDocuments({ handId: 'disabled' }), 0);
    assert.equal((await tickets.personalStatus(user._id, tableId)).nextHandPurchased, true);
    await Pool.updateOne({ key: 'default' }, { $set: { enabled: true } });
    await tickets.prepareHand({ tableId, handId: 'combined', startedAt: Date.now(), userIds: [user._id] });
    assert.equal(await h.getWalletBalance(user._id), 90000);
    await tickets.buyNext(user._id, tableId, 'buy-once');
    assert.equal((await tickets.personalStatus(user._id, tableId)).nextHandPurchased, false);
    assert.equal(await h.getWalletBalance(user._id), 90000);
    // A legacy lifetime member without a round ticket never qualifies.
    await Member.create({ userId: outsider._id, active: true });
    const result = await h.service.reservePayoutForHand({ tableId, handId: 'combined',
      gameType: 'poker', reason: 'showdown', community: ISLAND_HANDS.royalFlush.community,
      seats: [h.buildSeat(outsider, 'royalFlush')] });
    assert.notEqual(result.status, 'reserved');
  });
});
