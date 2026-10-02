const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PokerTable } = require('../sockets/tableGame');

function game(t, stacks) {
  const g = new PokerTable({ in: () => ({ fetchSockets: async () => [] }) }, {
    _id: 'effective-stack', smallBlind: 500, bigBlind: 1000,
    minBuyIn: 10000, maxBuyIn: 1000000, seats: [],
  });
  t.after(() => g.disposeTimers());
  g.seats = stacks.map((chips, i) => ({ userId: `p${i}`, seatPosition: i,
    chips, invested: 0, bet: 0, inHand: true, folded: false, allIn: false,
    actedThisStreet: false }));
  g.currentBet = 0;
  g.running = true;
  g.round = 'flop';
  return g;
}

test('million stack can wager only fifty thousand against two fifty-thousand stacks', t => {
  const g = game(t, [1000000, 50000, 50000]);
  assert.equal(g.computeTurnActionSpec(0).maxRaise, 50000);
  g.applyBetOrRaise(0, 1000000);
  assert.equal(g.seats[0].chips, 950000);
  assert.equal(g.pot, 50000);
  assert.equal(g.seats[0].allIn, false);
});

test('cap accounts for money already invested and ignores folded/waiting stacks', t => {
  const g = game(t, [990000, 30000, 5000000, 9000000]);
  Object.assign(g.seats[0], { invested: 10000, bet: 1000 });
  Object.assign(g.seats[1], { invested: 20000, bet: 11000 });
  g.seats[2].folded = true;
  g.seats[3].inHand = false;
  g.currentBet = 11000;
  assert.equal(g.computeTurnActionSpec(0).callAmount, 10000);
  assert.equal(g.computeTurnActionSpec(0).maxRaise, 30000);
});

test('lone funded player must call first, then all remaining streets settle without checks', t => {
  const g = game(t, [1000000, 0, 0]);
  for (const s of g.seats.slice(1)) Object.assign(s, { allIn: true, invested: 50000, bet: 50000 });
  g.currentBet = 50000;
  assert.equal(g.bettingIsClosed(), false);
  assert.equal(g.computeTurnActionSpec(0).maxRaise, 0);
  g.applyCall(0);
  assert.equal(g.everyoneSettled(), true);
  for (const round of ['turn', 'river']) {
    g.endBettingRound();
    g.round = round;
    assert.equal(g.everyoneSettled(), true);
  }
});

test('two players with chips retain betting decisions and side-pot raises', t => {
  const g = game(t, [1000000, 100000, 0]);
  Object.assign(g.seats[2], { allIn: true, invested: 50000, bet: 50000 });
  g.currentBet = 50000;
  g.applyCall(0);
  assert.equal(g.bettingIsClosed(), false);
  assert.equal(g.computeTurnActionSpec(1).maxRaise, 50000);
});

test('covered short raise keeps the previous full-raise minimum', t => {
  const g = game(t, [1000000, 500]);
  g.lastRaiseAmount = 1000;
  g.applyBetOrRaise(0, 500);
  assert.equal(g.lastRaiseAmount, 1000);
  assert.equal(g.shortAllInNoReopen, true);
});
