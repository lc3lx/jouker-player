/**
 * Seats left behind by a player who never returned must expire.
 *
 * The boot sanitiser preserves a seated table so a player restarting their app
 * gets their chair back. It used to preserve it UNCONDITIONALLY, so a seat whose
 * owner never came back survived every reboot: the one-table-per-player gate then
 * answered every later join with "you are already active at another table" (or
 * pushed them into a waiting queue), and their buy-in stayed locked. Real tables
 * in the live database had been holding seats for three months.
 *
 * Preserving the seat is still right — it just has to be provisional.
 */
process.env.NODE_ENV = "test";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const gc = require("../services/tableGcService");

beforeEach(() => gc.clearSeatWatches());

test("a poker table kept for its seated humans is watched, not kept forever", async () => {
  const result = await gc.sanitizePokerTableOnBoot(
    {
      _id: "t-poker-1",
      gameType: "poker",
      status: "waiting",
      seats: [{ user: "u1", chips: 10000 }],
      vacatingPlayers: [],
      waitingQueue: [],
    },
    null // no Redis → no snapshot → the "keep seated" branch
  );

  assert.equal(result.action, "keep_seated");
  const watched = gc.getSeatWatchState().poker.map((w) => w.tableId);
  assert.deepEqual(watched, ["t-poker-1"], "the preserved seat is on the clock");
});

test("a poker table kept for an active vacate window is watched too", async () => {
  const result = await gc.sanitizePokerTableOnBoot(
    {
      _id: "t-poker-2",
      gameType: "poker",
      status: "waiting",
      seats: [],
      vacatingPlayers: [
        { user: "u1", chips: 5000, vacateUntil: new Date(Date.now() + 60_000) },
      ],
      waitingQueue: [],
    },
    null
  );

  assert.equal(result.action, "keep_seated");
  assert.equal(gc.getSeatWatchState().poker.length, 1);
});

test("a tournament poker table is left entirely to its engine", async () => {
  const result = await gc.sanitizePokerTableOnBoot(
    {
      _id: "t-poker-3",
      gameType: "poker",
      tableKind: "tournament",
      status: "playing",
      seats: [{ user: "u1", chips: 10000 }],
    },
    null
  );

  assert.equal(result.action, "skipped");
  assert.equal(gc.getSeatWatchState().poker.length, 0, "no watch on tournament tables");
});

test("a preserved open card lobby holding seats is watched", async () => {
  const result = await gc.sanitizeCardTableOnBoot({
    _id: "t-trix-1",
    gameType: "trix",
    status: "open",
    activeSettlementId: null,
    seats: [{ user: "u1", chips: 200000 }],
  });

  assert.equal(result.reason, "open_lobby_preserved");
  const watched = gc.getSeatWatchState().card;
  assert.equal(watched.length, 1);
  assert.equal(watched[0].tableId, "t-trix-1");
  assert.equal(watched[0].gameType, "trix");
});

test("an empty open card lobby is left alone — nothing to release", async () => {
  const result = await gc.sanitizeCardTableOnBoot({
    _id: "t-trix-2",
    gameType: "trix",
    status: "open",
    activeSettlementId: null,
    seats: [],
  });

  assert.equal(result.reason, "open_lobby_preserved");
  assert.equal(gc.getSeatWatchState().card.length, 0);
});

test("the card seat watch waits out the grace window before releasing", async () => {
  await gc.sanitizeCardTableOnBoot({
    _id: "t-trix-3",
    gameType: "trix",
    status: "open",
    activeSettlementId: null,
    seats: [{ user: "u1", chips: 1000 }],
  });

  // No namespace wired (as in a bare process) → the sweep must not touch it.
  await gc.sweepCardSeatWatch();
  assert.equal(
    gc.getSeatWatchState().card.length,
    1,
    "still watched — release is the sweep's job once sockets can be counted"
  );
});

test("the grace window is a real, positive duration", () => {
  assert.ok(
    gc.POKER_RECOVERED_NO_SOCKETS_MS >= 30_000,
    "a reconnecting player needs time to get back"
  );
});
