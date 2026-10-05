"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PokerTable } = require("../sockets/tableGame");

function game(t) {
  const g = new PokerTable({ in: () => ({ fetchSockets: async () => [] }) }, {
    _id: "inactivity", smallBlind: 5, bigBlind: 10, minBuyIn: 100,
    maxBuyIn: 1000, seats: [],
  });
  t.after(() => g.disposeTimers());
  g.seats = [{ userId: "human", chips: 100, seatPosition: 0 }];
  g.leaves = [];
  g.abandonHumanSeat = async uid => { g.leaves.push(uid); };
  return g;
}
function finish(g, id, types) {
  g.currentHandId = id;
  g.currentHandActions = types.map(type => ({ type, playerId: "human" }));
  g.recordCompletedHandInactivity();
}

test("two timed-out hands remove a human; streets/replayed settlement count only once", t => {
  const g = game(t);
  finish(g, "one", ["timeout_call", "timeout_fold"]);
  finish(g, "one", ["timeout_fold"]);
  assert.equal(g.seats[0].inactiveHands, 1);
  assert.deepEqual(g.leaves, []);
  finish(g, "two", ["timeout_fold"]);
  assert.deepEqual(g.leaves, ["human"]);
  assert.equal(g.seats[0].playerState, "LEAVE_PENDING");
  assert.equal(g.onPlayerSocketConnected("human"), false);
});

test("a real action resets inactivity even if another street times out", t => {
  const g = game(t);
  finish(g, "one", ["timeout_fold"]);
  finish(g, "two", ["check", "timeout_fold"]);
  finish(g, "three", ["timeout_fold"]);
  assert.equal(g.seats[0].inactiveHands, 1);
  assert.deepEqual(g.leaves, []);
});

test("waiting players, forced blinds and bots are not treated as missed turns", t => {
  const g = game(t);
  finish(g, "one", ["big_blind"]);
  finish(g, "two", []);
  g.seats[0].isBot = true;
  finish(g, "three", ["timeout_fold"]);
  finish(g, "four", ["timeout_fold"]);
  assert.deepEqual(g.leaves, []);
});

test("frozen settlement does not count and owner snapshot retains the streak", t => {
  const g = game(t);
  g.frozen = true;
  finish(g, "failed", ["timeout_fold"]);
  assert.equal(g.seats[0].inactiveHands, undefined);
  g.frozen = false;
  finish(g, "one", ["timeout_fold"]);
  const restored = game(t);
  restored.restoreFromSnapshot(g.serializeSnapshot());
  assert.equal(restored.seats[0].inactiveHands, 1);
  finish(restored, "two", ["timeout_fold"]);
  assert.deepEqual(restored.leaves, ["human"]);
});

test("inactive eviction waits for the settlement lock and cashes out the settled stack", { timeout: 2000 }, async t => {
  const g = game(t);
  g.abandonHumanSeat = PokerTable.prototype.abandonHumanSeat;
  g.botsEnabled = false;
  g.running = false;
  g.round = "idle";
  g.seats.push({ userId: "active", chips: 200, seatPosition: 1 });
  g.currentIndex = 1;
  g.broadcastState = async () => {};
  let unlock;
  g.acquireActionLockWithin = () => new Promise(resolve => { unlock = resolve; });
  g.releaseActionLock = async () => {};
  let complete;
  const removed = new Promise(resolve => { complete = resolve; });
  t.mock.method(require("../services/pokerVacateService"), "permanentLeavePokerTable", async args => {
    assert.equal(args.userId, "human");
    assert.equal(args.uncommittedChips, 175);
    assert.equal(args.forfeitedBet, 0);
    complete();
  });
  finish(g, "one", ["timeout_fold"]);
  g.seats[0].chips = 175; // authoritative post-settlement balance
  finish(g, "two", ["timeout_fold"]);
  assert.equal(g.seats.length, 2);
  assert.equal(g.seats[0].playerState, "LEAVE_PENDING");
  unlock(true);
  await removed;
  assert.equal(g.findSeatIndexByUser("human"), -1);
  assert.equal(g.seats[0].userId, "active");
});

test("disconnected and sitting-out seats expire after two completed table hands without being dealt", t => {
  for (const state of ["DISCONNECTED", "SITTING_OUT"]) {
    const g = game(t);
    Object.assign(g.seats[0], { playerState: state, inHand: false });
    finish(g, "one", []);
    assert.equal(g.seats[0].inactiveHands, 1);
    finish(g, "two", []);
    assert.deepEqual(g.leaves, ["human"]);
    assert.equal(g.seats[0].playerState, "LEAVE_PENDING");
  }
});

test("a busy eviction retries a pending seat on the next completed hand", async t => {
  const g = game(t);
  g.abandonHumanSeat = async uid => { g.leaves.push(uid); return false; };
  finish(g, "one", ["timeout_fold"]);
  finish(g, "two", ["timeout_fold"]);
  await new Promise(resolve => setImmediate(resolve));
  finish(g, "three", []);
  assert.deepEqual(g.leaves, ["human", "human"]);
});

test("owner recovery resumes an inactive leave-pending seat", t => {
  const g = game(t);
  Object.assign(g.seats[0], { playerState: "LEAVE_PENDING", inactiveHands: 2 });
  const restored = game(t);
  restored.restoreFromSnapshot(g.serializeSnapshot());
  assert.deepEqual(restored.leaves, ["human"]);
});

test("failed engine lock does not force a cash-out of a live chair", async t => {
  const g = game(t);
  g.leavePlayerImmediately = async () => null;
  t.mock.method(require("../services/pokerVacateService"), "permanentLeavePokerTable", async () => {
    assert.fail("cash-out while the engine still owns the chair");
  });
  assert.equal(await PokerTable.prototype.abandonHumanSeat.call(g, "human"), false);
  assert.equal(g.findSeatIndexByUser("human"), 0);
});

test("inactive cleanup retries even when the table no longer deals hands", { timeout: 3000 }, async t => {
  const g = game(t);
  let retried;
  const retry = new Promise(resolve => { retried = resolve; });
  g.abandonHumanSeat = async uid => {
    g.leaves.push(uid);
    if (g.leaves.length === 1) return false;
    retried();
    return true;
  };
  finish(g, "one", ["timeout_fold"]);
  finish(g, "two", ["timeout_fold"]);
  await retry;
  assert.deepEqual(g.leaves, ["human", "human"]);
});
