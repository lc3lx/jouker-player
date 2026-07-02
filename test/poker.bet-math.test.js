const { test } = require("node:test");
const assert = require("node:assert/strict");

/** Mirrors frontapp/lib/features/game/poker/poker_bet_math.dart for node tests. */
function pokerFullPotRaiseExtra({ pot, callAmount, minExtra }) {
  if (callAmount > 0) return pot + callAmount + callAmount;
  if (pot > 0) return pot;
  return minExtra;
}

function pokerHalfPotRaiseExtra({ pot, callAmount, minExtra }) {
  const full = pokerFullPotRaiseExtra({ pot, callAmount, minExtra });
  if (full <= minExtra) return minExtra;
  return Math.floor((full - minExtra) / 2) + minExtra;
}

test("pot raise extra matches NL formula when facing a bet", () => {
  // pot=15, bet=10 → extra = 15+10+10 = 35 (PokerListings NL guide)
  assert.equal(pokerFullPotRaiseExtra({ pot: 15, callAmount: 10, minExtra: 10 }), 35);
});

test("half pot raise sits between min and full pot extra", () => {
  const min = 10;
  const half = pokerHalfPotRaiseExtra({ pot: 15, callAmount: 10, minExtra: min });
  const full = pokerFullPotRaiseExtra({ pot: 15, callAmount: 10, minExtra: min });
  assert.ok(half >= min);
  assert.ok(half <= full);
});

test("opening bet preset uses pot or min when no call", () => {
  assert.equal(pokerFullPotRaiseExtra({ pot: 0, callAmount: 0, minExtra: 100 }), 100);
  assert.equal(pokerFullPotRaiseExtra({ pot: 500, callAmount: 0, minExtra: 100 }), 500);
});
