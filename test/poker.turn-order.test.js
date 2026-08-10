const test = require("node:test");
const assert = require("node:assert/strict");

const { PokerTable } = require("../sockets/tableGame");

function mkSeat(userId, seatPosition, extras = {}) {
  return {
    userId,
    name: userId,
    chips: 1000,
    inHand: true,
    folded: false,
    allIn: false,
    bet: 0,
    invested: 0,
    isBot: String(userId).startsWith("bot"),
    hole: [],
    lastAction: null,
    actedThisStreet: false,
    seatPosition,
    ...extras,
  };
}

function mkTable(seats) {
  const nsp = { to: () => ({ emit: () => {} }), emit: () => {} };
  const table = {
    _id: "turn_order_table",
    smallBlind: 5,
    bigBlind: 10,
    minBuyIn: 200,
    maxBuyIn: 2000,
    buyIn: 500,
    capacity: 9,
    seats: [],
  };
  const game = new PokerTable(nsp, table);
  game.seats = seats;
  game.dealerIndex = 0;
  game.currentIndex = 0;
  game.capacity = 9;
  game.running = true;
  return game;
}

test("seatOrderFrom walks clockwise by seatPosition even when array is scrambled", () => {
  // Array order [0,4,1,2] as after bot push — old code yielded 0→4→1→2.
  const game = mkTable([
    mkSeat("h0", 0),
    mkSeat("h4", 4),
    mkSeat("b1", 1),
    mkSeat("b2", 2),
  ]);
  // Dealer at array index of chair 0
  game.dealerIndex = 0;
  const order = game.seatOrderFrom(game.dealerIndex);
  const chairs = order.map((i) => game.seats[i].seatPosition);
  assert.deepEqual(chairs, [1, 2, 4, 0]);
});

test("nextToActAfter skips folded and follows chair order not array order", () => {
  const game = mkTable([
    mkSeat("h0", 0),
    mkSeat("h4", 4),
    mkSeat("b1", 1, { folded: true }),
    mkSeat("b2", 2),
  ]);
  // Current actor = chair 0 (index 0) → next eligible chair should be 2 (skip folded 1), not 4.
  const next = game.nextToActAfter(0);
  assert.equal(game.seats[next].seatPosition, 2);
  assert.equal(game.seats[next].userId, "b2");
});

test("reindexSeatsByPosition restores array order and remaps dealer/current", () => {
  const game = mkTable([
    mkSeat("h0", 0),
    mkSeat("h4", 4),
    mkSeat("b1", 1),
    mkSeat("b2", 2),
  ]);
  game.dealerIndex = 1; // h4
  game.currentIndex = 3; // b2
  game.reindexSeatsByPosition();
  assert.deepEqual(
    game.seats.map((s) => s.seatPosition),
    [0, 1, 2, 4]
  );
  assert.equal(game.seats[game.dealerIndex].userId, "h4");
  assert.equal(game.seats[game.currentIndex].userId, "b2");
});

test("addBotsForMissingSeats reindexes so turn order stays clockwise", () => {
  const game = mkTable([mkSeat("human", 0), mkSeat("human2", 4)]);
  game.botsEnabled = true;
  game.botFillTarget = 4;
  game.botSerial = 0;
  // createBotSeat uses nextFreeSeatPosition — chairs 1 then 2
  const added = game.addBotsForMissingSeats();
  assert.ok(added >= 2);
  const chairs = game.seats.map((s) => s.seatPosition);
  const sorted = [...chairs].sort((a, b) => a - b);
  assert.deepEqual(chairs, sorted, "seats array must be sorted by chair after bot fill");
  game.dealerIndex = game.seats.findIndex((s) => s.seatPosition === 0);
  const orderChairs = game.seatOrderFrom(game.dealerIndex).map((i) => game.seats[i].seatPosition);
  // After dealer at 0, clockwise among occupied
  for (let i = 1; i < orderChairs.length; i++) {
    // wrap-aware: each step should increase until wrap to 0 at end
    if (orderChairs[i] !== 0) {
      assert.ok(
        orderChairs[i] > orderChairs[i - 1] || orderChairs[i - 1] === orderChairs[orderChairs.length - 1],
        `expected clockwise chairs, got ${orderChairs}`
      );
    }
  }
  assert.equal(orderChairs[0], 1);
});
