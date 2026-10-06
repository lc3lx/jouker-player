const test = require('node:test');
const assert = require('node:assert/strict');
const { PokerTable } = require('../sockets/tableGame');
function table(tier) {
  return new PokerTable({ to: () => ({ emit() {} }), in: () => ({ fetchSockets: async () => [] }) }, {
    _id: 'bot-policy', tier, capacity: 9, smallBlind: 100, bigBlind: 200,
    minBuyIn: 10000, maxBuyIn: 10000,
    seats: [{ user: { _id: 'human', name: 'Human' }, chips: 10000, seatPosition: 4 }],
    settings: { botsEnabled: true },
  });
}
for (const tier of ['beginner', 'intermediate', 'beast']) {
  test(`${tier} enforces its bot ceiling and retains policy across reset`, () => {
    const g = table(tier);
    let serial = 0;
    g.createBotSeat = () => ({ userId: `bot-${++serial}`, isBot: true, chips: 10000, seatPosition: serial - 1 });
    g.addBotsForMissingSeats();
    g.addBotsForMissingSeats();
    assert.equal(g.seatedBotCount(), tier === 'beast' ? 0 : 2);
    g.resetStateFromTable({ seats: [], settings: { botsEnabled: true } });
    assert.equal(g.botsEnabled, tier !== 'beast');
  });
}
test('bot checks/calls/folds without opening or raising any bet', async () => {
  const g = table('beginner');
  g.running = true;
  g.currentIndex = 0;
  g.seats = [{ userId: 'bot', isBot: true, inHand: true, chips: 10000, bet: 0 }];
  g.botRaiseSize = () => { throw new Error('attempted raise sizing'); };
  g.applyBetOrRaise = () => { throw new Error('bot raised'); };
  g.applyCall = () => {};
  g.applyFold = () => {};
  g.markVoluntaryAction = () => {};
  g.recordSeatAction = (_, action) => assert.ok(['check', 'call', 'fold'].includes(action));
  g.pacedAdvanceAfterAction = async () => {};
  for (const amount of [0, 200, 1000, 10000]) {
    g.currentBet = amount;
    await g._playBotTurnLocked(0);
  }
});
