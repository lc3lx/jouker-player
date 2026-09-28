"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PokerTable } = require("../sockets/tableGame");
const { canBeDealtIntoHand, canParticipateInNextHand, markActiveHandParticipants } = require("../utils/poker/playerState");

function game(t) {
  const g = new PokerTable({ to() { return { emit() {} }; } }, {
    _id: "grace-test", smallBlind: 100, bigBlind: 200,
    minBuyIn: 10000, maxBuyIn: 10000, capacity: 9,
    seats: [{ user: { _id: "u1", name: "One" }, chips: 10000, seatPosition: 3 }],
  });
  g.resyncTurnAfterReconnect = async () => {};
  g.broadcastState = async () => {};
  g.leaves = [];
  g.abandonHumanSeat = async (uid) => { g.leaves.push(uid); };
  t.after(() => g.disposeTimers());
  return g;
}

test("drop holds the exact chair, cards, stack and contributions for 30 seconds", (t) => {
  const g = game(t), s = g.seats[0];
  Object.assign(s, { chips: 8000, invested: 2000, inHand: true, hole: ["As", "Ah"], folded: false });
  t.mock.method(Date, "now", () => 100000);
  g.onPlayerSocketDisconnected("u1");
  assert.equal(s.reconnectDeadline, 130000);
  assert.equal(s.playerState, "DISCONNECTED");
  assert.equal(s.folded, false);
  assert.equal(s.chips, 8000);
  assert.equal(s.invested, 2000);
  assert.deepEqual(g.leaves, []);
  assert.equal(g.onPlayerSocketConnected("u1"), true);
  assert.equal(g.seats[0], s);
  assert.equal(s.seatPosition, 3);
  assert.deepEqual(s.hole, ["As", "Ah"]);
  assert.equal(s.playerState, "ACTIVE_HAND");
  assert.equal(g.reconnectTimers.size, 0);
});

test("duplicate disconnect and owner recovery never renew the deadline", (t) => {
  const g = game(t), s = g.seats[0];
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  g.onPlayerSocketDisconnected("u1");
  now += 20000;
  g.onPlayerSocketDisconnected("u1");
  g.rescheduleReconnectTimersAfterRestore();
  assert.equal(s.disconnectedAt, 100000);
  assert.equal(s.reconnectDeadline, 130000);
  assert.deepEqual(g.leaves, []);
});

test("stale expiry cannot remove a reconnected player or a later disconnect", async (t) => {
  const g = game(t);
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  g.onPlayerSocketDisconnected("u1");
  const oldDeadline = g.seats[0].reconnectDeadline;
  g.onPlayerSocketConnected("u1");
  now += 1000;
  g.onPlayerSocketDisconnected("u1");
  now = oldDeadline;
  await g.expireRecoveredReconnect("u1", oldDeadline);
  assert.equal(g.seats[0].playerState, "DISCONNECTED");
  assert.equal(g.reconnectTimers.size, 1);
  assert.deepEqual(g.leaves, []);
});

test("expiry is idempotent and does not fold an all-in or alter its pot rights", async (t) => {
  const g = game(t), s = g.seats[0];
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  Object.assign(s, { inHand: true, allIn: true, chips: 0, invested: 10000, folded: false });
  g.onPlayerSocketDisconnected("u1");
  const deadline = s.reconnectDeadline;
  now = deadline;
  await g.expireRecoveredReconnect("u1", deadline);
  await g.expireRecoveredReconnect("u1", deadline);
  assert.deepEqual(g.leaves, ["u1"]);
  assert.equal(s.playerState, "LEAVE_PENDING");
  assert.equal(s.folded, false);
  assert.equal(s.invested, 10000);
  assert.equal(g.onPlayerSocketConnected("u1"), false);
});

test("a reconnect at the deadline expires even before the timer callback runs", (t) => {
  const g = game(t);
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  g.onPlayerSocketDisconnected("u1");
  now += 30000;
  assert.equal(g.onPlayerSocketConnected("u1"), false);
  assert.deepEqual(g.leaves, ["u1"]);
});

test("explicit app exit cancels grace immediately and duplicate exit is harmless", async (t) => {
  const g = game(t);
  g.onPlayerSocketDisconnected("u1");
  await g.leavePlayerPermanently("u1");
  await g.leavePlayerPermanently("u1");
  assert.equal(g.reconnectTimers.size, 0);
  assert.equal(g.seats[0].playerState, "LEAVE_PENDING");
  assert.deepEqual(g.leaves, ["u1"]);
});

test("leave button cancels grace without waiting for its deadline", async (t) => {
  const g = game(t);
  g.acquireActionLock = async () => true;
  g.releaseActionLock = async () => {};
  g.onPlayerSocketDisconnected("u1");
  assert.equal(await g.requestPlayerLeave("u1"), true);
  assert.equal(g.reconnectTimers.size, 0);
  assert.equal(g.onPlayerSocketConnected("u1"), false);
});

test("disconnected players skip new deals and state normalization retains grace", (t) => {
  const g = game(t), s = g.seats[0];
  g.onPlayerSocketDisconnected("u1");
  assert.equal(canBeDealtIntoHand(s), false);
  assert.equal(canParticipateInNextHand(s), false);
  s.inHand = true;
  markActiveHandParticipants(g.seats);
  assert.equal(s.playerState, "DISCONNECTED");
  g.onPlayerSocketConnected("u1");
  assert.equal(canBeDealtIntoHand(s), true);
});

test("a former owner cannot expire or disconnect a seat", async (t) => {
  const g = game(t);
  g.onPlayerSocketDisconnected("u1");
  const deadline = g.seats[0].reconnectDeadline;
  g.isOwner = false;
  t.mock.method(Date, "now", () => deadline + 1);
  await g.expireRecoveredReconnect("u1", deadline);
  assert.deepEqual(g.leaves, []);
});

test("buffered actions cannot bet after disconnect or exit intent", async (t) => {
  const g = game(t);
  g.acquireActionLock = async () => true;
  g.releaseActionLock = async () => {};
  g.running = true;
  g.round = "preflop";
  g.currentIndex = 0;
  g.seats[0].inHand = true;
  for (const state of ["DISCONNECTED", "LEAVE_PENDING"]) {
    g.seats[0].playerState = state;
    const result = await g.handleAction("u1", { action: "raise", amount: 500, actionId: state });
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "NOT_IN_HAND");
    assert.equal(g.seats[0].chips, 10000);
  }
});
