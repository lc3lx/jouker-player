const test = require('node:test');
const assert = require('node:assert/strict');
const { utcWeekKey } = require('../services/islandJackpotService');
const { evaluateIslandHand } = require('../utils/islandJackpotHand');
const { newDeck, shuffleDeterministic, draw } = require('../utils/poker/deck');

test('utcWeekKey produces consistent Monday dates', () => {
  const d1 = new Date('2026-10-03T10:00:00Z'); // Saturday
  const key1 = utcWeekKey(d1);
  assert.equal(key1, '2026-09-28'); // Monday of that week

  const d2 = new Date('2026-09-28T05:00:00Z'); // Monday
  const key2 = utcWeekKey(d2);
  assert.equal(key2, '2026-09-28');

  const d3 = new Date('2026-10-04T23:59:59Z'); // Sunday
  const key3 = utcWeekKey(d3);
  assert.equal(key3, '2026-09-28');

  const d4 = new Date('2026-10-05T00:00:01Z'); // Next Monday
  const key4 = utcWeekKey(d4);
  assert.equal(key4, '2026-10-05');
});

test('100M forced deal guarantees winning hand for winner and community cards', () => {
  // Mock table with 3 seats
  const { PokerTable } = require('../sockets/tableGame');
  // Create minimal mock instance
  const seats = [
    { inHand: true, folded: false, allIn: false, chips: 1000, userId: 'user1', isBot: false },
    { inHand: true, folded: false, allIn: false, chips: 1000, userId: 'user2', isBot: true },
    { inHand: true, folded: false, allIn: false, chips: 1000, userId: 'user3', isBot: true },
  ];

  const fakeTable = {
    seats,
    community: [],
    burn(n = 1) {
      draw(this.deck, n);
    },
    dealCommunity(n) {
      this.community.push(...draw(this.deck, n));
    },
    dealHoleCards: PokerTable.prototype.dealHoleCards,
  };

  const deck = newDeck();
  const forcedWinnerSeat = seats[0];

  fakeTable.dealHoleCards(deck, forcedWinnerSeat);

  // Winner has 2 hole cards
  assert.equal(forcedWinnerSeat.hole.length, 2);

  // Other seats received 2 cards each
  assert.equal(seats[1].hole.length, 2);
  assert.equal(seats[2].hole.length, 2);

  // Simulate Texas Holdem community dealing:
  fakeTable.deck = deck;
  fakeTable.burn(1);
  fakeTable.dealCommunity(3); // Flop
  assert.equal(fakeTable.community.length, 3);

  fakeTable.burn(1);
  fakeTable.dealCommunity(1); // Turn
  assert.equal(fakeTable.community.length, 4);

  fakeTable.burn(1);
  fakeTable.dealCommunity(1); // River
  assert.equal(fakeTable.community.length, 5);

  // Evaluate winner hand
  const evaluated = evaluateIslandHand(forcedWinnerSeat.hole, fakeTable.community);
  assert.ok(evaluated, 'Winner hand must evaluate to an island winning hand');
  const validWinningTypes = ['royalFlush', 'straightFlush', 'fourOfAKind'];
  assert.ok(validWinningTypes.includes(evaluated.handType), `Hand type ${evaluated?.handType} must be one of winning hands`);
});
