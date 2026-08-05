const { test } = require("node:test");
const assert = require("node:assert/strict");

const { calculateRake, resolveRakePolicy } = require("../utils/poker/rakePolicy");
const { PokerTable } = require("../sockets/tableGame");

function nspStub() {
  return {
    to() { return { emit() {} }; },
    in() { return { async fetchSockets() { return []; } }; },
  };
}

function table() {
  return {
    _id: "rake-policy-table",
    smallBlind: 50,
    bigBlind: 100,
    minBuyIn: 1000,
    maxBuyIn: 10000,
    capacity: 9,
    rake: { percent: 0.05, cap: 200, noFlopNoDrop: true },
    seats: [
      { user: { _id: "u1", name: "P1" }, chips: 5000 },
      { user: { _id: "u2", name: "P2" }, chips: 5000 },
      { user: { _id: "u3", name: "P3" }, chips: 5000 },
    ],
  };
}

test("no-flop-no-drop and cap are enforced by the rake policy", () => {
  const policy = resolveRakePolicy({ rake: { percent: 0.05, cap: 200, noFlopNoDrop: true } });
  assert.equal(calculateRake({ contestedPot: 4000, flopDealt: false, policy }), 0);
  assert.equal(calculateRake({ contestedPot: 4000, flopDealt: true, policy }), 200);
  assert.equal(calculateRake({ contestedPot: 10000, flopDealt: true, policy }), 200);
});

test("a one-player upper side-pot level is returned and is not a contested pot", () => {
  const game = new PokerTable(nspStub(), table());
  game.dealerIndex = 0;
  for (const seat of game.seats) {
    seat.inHand = true;
    seat.folded = false;
  }
  // P3 is the only player who supplied the final 300 chips.
  game.seats[0].invested = 100;
  game.seats[1].invested = 200;
  game.seats[2].invested = 500;
  const ranks = new Map([
    [0, { cat: 4, tiebreak: [14] }],
    [1, { cat: 3, tiebreak: [13] }],
    [2, { cat: 2, tiebreak: [12] }],
  ]);

  const result = game.resolveSidePotPayoutsWithDistribution(ranks);
  assert.equal(result.uncalledReturns.get(2), 300);
  assert.equal(result.payouts.get(0), 300);
  assert.equal(result.payouts.get(1), 200);
  assert.equal(result.payouts.get(2), 300);
  assert.deepEqual(
    result.potDistribution.map((pot) => pot.kind),
    ["contested", "contested", "uncalled_return"]
  );
});

test("voluntary leave folds the player but retains the seat for safe settlement", async () => {
  const game = new PokerTable(nspStub(), table());
  game.running = true;
  game.round = "flop";
  game.currentIndex = 1;
  game.broadcastState = async () => {};
  for (const seat of game.seats) {
    seat.inHand = true;
    seat.folded = false;
    seat.allIn = false;
  }

  const accepted = await game.requestPlayerLeave("u1");
  assert.equal(accepted, true);
  assert.equal(game.seats[0].playerState, "LEAVE_PENDING");
  assert.equal(game.seats[0].folded, true);
  assert.equal(game.findSeatIndexByUser("u1"), 0);
});
