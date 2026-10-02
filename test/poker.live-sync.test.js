"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PokerTable } = require("../sockets/tableGame");

function game(t) {
  const g = new PokerTable({ in: () => ({ fetchSockets: async () => [] }) }, {
    _id: "live-sync", smallBlind: 5, bigBlind: 10, minBuyIn: 100,
    maxBuyIn: 1000, seats: [],
  });
  t.after(() => g.disposeTimers());
  g.running = true;
  g.round = "flop";
  g.currentHandId = "hand-1";
  g.currentIndex = 0;
  g.seats = [0, 1].map(i => ({ userId: `human-${i}`, seatPosition: i,
    chips: 100, bet: 0, invested: 0, inHand: true, folded: false,
    allIn: false, actedThisStreet: i === 0 }));
  g.auditChipConservation = async () => true;
  return g;
}

test("next actor snapshot includes the newly scheduled deadline", async t => {
  const g = game(t);
  g.actionDeadline = 123;
  const frames = [];
  g.broadcastState = async () => frames.push(g.getPublicState("human-1"));
  await g.advance();
  assert.equal(frames.at(-1).turnUserId, "human-1");
  assert.ok(frames.at(-1).actionDeadline > Date.now());
});

test("old timeout cannot act on a later turn at the same seat", async t => {
  const g = game(t);
  g.actionDeadline = 200;
  g.pacedAdvanceAfterAction = async () => assert.fail("stale timeout advanced hand");
  await g.handleTimeout(0, 100, "hand-1");
  await g.handleTimeout(0, 200, "old-hand");
  assert.equal(g.seats[0].folded, false);
});

test("presentation transition never advertises the previous actor's buttons", t => {
  const g = game(t);
  g._turnTransition = true;
  assert.equal(g.getPublicState("human-0").turnUserId, null);
  g.scheduleCurrentTurn();
  assert.equal(g.getPublicState("human-0").turnUserId, "human-0");
});

test("resync does not restart clocks during action processing or showdown", async t => {
  const g = game(t);
  g.scheduleCurrentTurn = () => assert.fail("resync scheduled a competing turn");
  g._actionLockHeld = true;
  await g.resyncTurnAfterReconnect("human-0");
  g._actionLockHeld = false;
  g.round = "showdown";
  await g.resyncTurnAfterReconnect("human-0");
});

test("runout advances under the action lock and releases it", async t => {
  const g = game(t);
  g.currentIndex = -1;
  let advanced = false;
  g.advance = async () => { assert.equal(g._actionLockHeld, true); advanced = true; };
  await g.advanceWithoutActor();
  assert.equal(advanced, true);
  assert.equal(g._actionLockHeld, false);
});

test("transient socket discovery failure cannot abort showdown presentation", async t => {
  const g = game(t);
  g.nsp = { in: () => ({ fetchSockets: async () => { throw Error("adapter timeout"); } }) };
  await g.emitToSeatedSockets("showdown_start", {});
  assert.equal(g.running, true);
  assert.equal(g.frozen, false);
});
