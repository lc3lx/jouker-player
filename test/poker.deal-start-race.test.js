process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PokerTable } = require("../sockets/tableGame");
const Table = require("../models/tableModel");

function game() {
  const g = new PokerTable({
    to: () => ({ emit() {} }),
    in: () => ({ fetchSockets: async () => [] }),
  }, {
    _id: "deal-race", smallBlind: 500, bigBlind: 1000,
    minBuyIn: 10000, maxBuyIn: 10000, capacity: 9,
    seats: [{ user: { _id: "u1", name: "Player" }, chips: 10000, seatPosition: 4 }],
  });
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};
  return g;
}

test("an expired inter-hand deadline does not add another full pause", async (t) => {
  const g = game();
  const delays = [];
  t.mock.method(global, "setTimeout", (_, delay) => { delays.push(delay); return 123; });
  g.nextHandNotBefore = Date.now() - 100;
  g.scheduleNextHand();
  assert.deepEqual(delays, [0]);
  g.nextHandTimer = null;
});

test("a lobby refresh must not reset a hand waiting for deal preparation", async () => {
  const g = game();
  g.running = true;
  g.starting = true;
  g.round = "preflop";
  g.currentHandId = "first-hand";
  g.seats[0].inHand = false;
  let reads = 0;
  g.healSeatsMissingSockets = async () => {};
  g.refreshSeatsFromDb = async () => { reads++; return true; };
  await g.bootstrapLobbyStart();
  assert.equal(g.currentHandId, "first-hand");
  assert.equal(g.round, "preflop");
  assert.equal(g.running, true);
  assert.equal(g.starting, true);
  assert.equal(reads, 0);
});

test("concurrent starts post blinds only once and release the guard", async () => {
  const g = game();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let deals = 0;
  g._dealHandOnce = async () => {
    deals++;
    await gate;
    g.postBlind(g.seats[0], 500);
  };
  const first = g.startHand();
  await g.startHand();
  assert.equal(deals, 1);
  release();
  await first;
  assert.equal(g.pot, 500);
  assert.equal(g.seats[0].chips, 9500);
  assert.equal(g._dealingHand, false);
});

test("a failed deal releases its guard for recovery", async () => {
  const g = game();
  g._dealHandOnce = async () => { throw new Error("prepare failed"); };
  await assert.rejects(g.startHand(), /prepare failed/);
  assert.equal(g._dealingHand, false);
});

test("a stale DB read cannot replace seats after dealing begins", async (t) => {
  const g = game();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(Table, "findById", () => ({ populate: () => gate }));
  const seats = g.seats;
  const refresh = g.refreshSeatsFromDb();
  g._dealingHand = true;
  g.round = "preflop";
  g.currentHandId = "live-hand";
  release({ seats: [], settings: {} });
  assert.equal(await refresh, false);
  assert.equal(g.seats, seats);
  assert.equal(g.currentHandId, "live-hand");
});

test("stale-round repair never clears a frozen or preparing hand", () => {
  for (const state of [{ frozen: true }, { _dealingHand: true }]) {
    const g = game();
    Object.assign(g, state, { running: false, round: "preflop", pot: 1500 });
    g.healStaleRoundIfNotRunning();
    assert.equal(g.round, "preflop");
    assert.equal(g.pot, 1500);
  }
});
