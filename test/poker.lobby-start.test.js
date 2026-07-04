/**
 * Lobby start / stale-state recovery tests.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { PokerTable } = require("../sockets/tableGame");
const { deriveMinimumBet } = require("../utils/poker/tableBettingConfig");
const { POKER_MIN_PLAYERS } = require("../utils/pokerTableStatus");

function createNspStub() {
  return {
    to() {
      return { emit() {} };
    },
    in() {
      return { async fetchSockets() { return []; } };
    },
  };
}

function mkTableDoc(overrides = {}) {
  const buyIn = overrides.buyIn ?? overrides.minBuyIn ?? 100000;
  return {
    _id: overrides._id || "lobby-table",
    smallBlind: overrides.smallBlind ?? 500,
    bigBlind: overrides.bigBlind ?? 1000,
    minBuyIn: buyIn,
    maxBuyIn: buyIn,
    buyIn,
    minimumBet: overrides.minimumBet ?? deriveMinimumBet(buyIn),
    capacity: 9,
    seats: overrides.seats ?? [
      { user: { _id: "u1", name: "Hero" }, chips: buyIn, seatPosition: 4 },
    ],
  };
}

function mkGame(overrides = {}) {
  const g = new PokerTable(createNspStub(), mkTableDoc(overrides));
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};
  g.startHand = async () => {
    g.running = true;
    g.round = "preflop";
  };
  return g;
}

test("healStaleRoundIfNotRunning resets showdown to idle", () => {
  const g = mkGame();
  g.round = "showdown";
  g.running = false;
  g.pot = 5000;
  g.healStaleRoundIfNotRunning();
  assert.equal(g.round, "idle");
  assert.equal(g.pot, 0);
});

test("bootstrapLobbyStart fills bots and starts for solo human", async () => {
  const g = mkGame();
  g.refreshSeatsFromDb = async () => true;
  let started = false;
  g.startHand = async () => {
    started = true;
    g.running = true;
    g.round = "preflop";
  };

  await g.bootstrapLobbyStart();

  assert.ok(g.activeSeatCount() >= POKER_MIN_PLAYERS);
  assert.equal(started, true);
});

test("reconcileEngineWithMongo reloads humans when snapshot seats are empty", async () => {
  const tableDoc = mkTableDoc();
  const g = mkGame();
  g.seats = [];
  g.round = "idle";
  g.running = false;
  g.refreshSeatsFromDb = async () => {
    g.resetStateFromTable(tableDoc);
    return true;
  };
  g.stateStore = { delete: async () => {} };

  await g.reconcileEngineWithMongo(tableDoc);

  assert.equal(g.humanSeatCount(), 1);
  assert.equal(g.round, "idle");
});

test("rescheduleWaitForPlayersAfterRestore fires immediately when deadline passed", async () => {
  const g = mkGame();
  g.seats = [];
  let windowEndCalls = 0;
  g.onWaitForPlayersWindowEnd = async () => {
    windowEndCalls += 1;
  };
  g.waitForPlayersDeadline = Date.now() - 1000;

  g.rescheduleWaitForPlayersAfterRestore();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(windowEndCalls, 1);
});

test("beginNextHandIfPossible auto-starts with bots after solo human hand", async () => {
  const g = mkGame();
  g.refreshSeatsFromDb = async () => true;
  g.round = "idle";
  g.running = false;
  let started = false;
  g.startHand = async () => {
    started = true;
    g.running = true;
    g.round = "preflop";
  };

  await g.beginNextHandIfPossible();

  assert.ok(g.activeSeatCount() >= POKER_MIN_PLAYERS);
  assert.equal(started, true);
});

test("scheduleWaitForPlayers starts hand when enough eligible humans", async () => {
  const g = mkGame({
    seats: [
      { user: { _id: "u1", name: "A" }, chips: 100000, seatPosition: 0 },
      { user: { _id: "u2", name: "B" }, chips: 100000, seatPosition: 1 },
    ],
  });
  g.resetStateFromTable(mkTableDoc({
    seats: [
      { user: { _id: "u1", name: "A" }, chips: 100000, seatPosition: 0 },
      { user: { _id: "u2", name: "B" }, chips: 100000, seatPosition: 1 },
    ],
  }));
  let started = false;
  g.startIfReady = async () => {
    started = true;
  };

  g.scheduleWaitForPlayers();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(started, true);
});

test("setRound allows fold-win path from any street to idle", () => {
  const g = mkGame();
  for (const street of ["preflop", "flop", "turn", "river"]) {
    g.round = street;
    assert.equal(g.setRound("idle"), true, `expected ${street} -> idle`);
    assert.equal(g.round, "idle");
  }
});
