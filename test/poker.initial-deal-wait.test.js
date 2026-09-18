const test = require('node:test');
const assert = require('node:assert/strict');
const { PokerTable } = require('../sockets/tableGame');

test('first hand waits 15 seconds; arrivals cannot bypass or restart the deadline', async () => {
  const g = new PokerTable({ to: () => ({ emit() {} }), in: () => ({ fetchSockets: async () => [] }) }, {
    _id: 'initial-wait', minBuyIn: 10000, maxBuyIn: 10000, smallBlind: 100, bigBlind: 200,
    seats: [{ user: { _id: 'human1', name: 'One' }, chips: 10000, seatPosition: 0 }],
  });
  g.healSeatsMissingSockets = async () => {};
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};
  g.autoRebuyBustedHumans = async () => {};
  let deals = 0;
  g.startHand = async () => { deals++; g.round = 'preflop'; };
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await g.startIfReady({ refreshFromDb: false });
    const deadline = g.initialDealDeadline;
    assert.equal(deadline, now + 15000);
    assert.equal(deals, 0);
    assert.equal(g.serializeSnapshot().initialDealDeadline, deadline);
    now += 7000;
    g.seats.push({ ...g.seats[0], userId: 'human2', seatPosition: 1 });
    await g.startIfReady({ refreshFromDb: false, allowBotFill: true });
    assert.equal(g.initialDealDeadline, deadline);
    assert.equal(g.waitForPlayersDeadline, deadline);
    assert.equal(deals, 0);
    now = deadline;
    await g.startIfReady({ refreshFromDb: false });
    assert.equal(deals, 1);
    g.running = false;
    g.round = 'idle';
    g.handCounter = 1;
    g.initialDealDeadline = null;
    await g.startIfReady({ refreshFromDb: false });
    assert.equal(deals, 2, 'subsequent hands keep their normal pacing');
  } finally {
    Date.now = realNow;
    g.clearWaitForPlayersTimer();
    g.clearBotFillTimer();
    g.clearActionScheduling();
  }
});
