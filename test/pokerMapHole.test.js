const test = require("node:test");
const assert = require("node:assert/strict");
const { mapHoleForClientView } = require("../sockets/tableGame");

const seatA = { userId: "user-a", hole: ["As", "Kh"] };

test("hero always sees own hole during preflop", () => {
  const v = mapHoleForClientView({
    round: "preflop",
    lastHand: null,
    seat: seatA,
    seatIndex: 0,
    forUserId: "user-a",
    showdownRevealedSeats: new Set(),
  });
  assert.deepEqual(v, ["As", "Kh"]);
});

test("opponent never sees hole preflop", () => {
  const v = mapHoleForClientView({
    round: "preflop",
    lastHand: null,
    seat: seatA,
    seatIndex: 0,
    forUserId: "user-b",
    showdownRevealedSeats: new Set(),
  });
  assert.deepEqual(v, [null, null]);
});

test("showdown: hidden until seat index is in reveal set", () => {
  const srs = new Set([1]);
  const hidden = mapHoleForClientView({
    round: "showdown",
    lastHand: null,
    seat: seatA,
    seatIndex: 0,
    forUserId: "user-b",
    showdownRevealedSeats: srs,
  });
  assert.deepEqual(hidden, [null, null]);
  const shown = mapHoleForClientView({
    round: "showdown",
    lastHand: null,
    seat: seatA,
    seatIndex: 0,
    forUserId: "user-b",
    showdownRevealedSeats: new Set([0]),
  });
  assert.deepEqual(shown, ["As", "Kh"]);
});

test("showdown: strict mode — no leak when reveal set missing", () => {
  const v = mapHoleForClientView({
    round: "showdown",
    lastHand: null,
    seat: seatA,
    seatIndex: 0,
    forUserId: null,
    showdownRevealedSeats: null,
  });
  assert.deepEqual(v, [null, null]);
});
