const test = require("node:test");
const assert = require("node:assert/strict");
const {
  findAvailableTable,
  joinFixedCapacityWithRetry,
  findUserSeatedTable,
} = require("../services/tableAllocationService");
const { LOBBY_EXCLUDED_STATUSES, isLobbyVisibleStatus } = require("../services/tableLifecycleService");

test("LOBBY_EXCLUDED_STATUSES hides archived and closed tables", () => {
  assert.ok(!isLobbyVisibleStatus("archived"));
  assert.ok(!isLobbyVisibleStatus("closed"));
  assert.ok(isLobbyVisibleStatus("open"));
  assert.deepEqual(LOBBY_EXCLUDED_STATUSES, ["closed", "archived"]);
});

test("joinFixedCapacityWithRetry is exported for tarneeb41 and trix via tableService", () => {
  const tableService = require("../services/tableService");
  assert.equal(typeof tableService.joinTarneeb41WithRetry, "function");
  assert.equal(typeof tableService.joinTrixWithRetry, "function");
  assert.equal(typeof tableService.findAvailableTrixTable, "function");
  assert.equal(typeof tableService.findUserSeatedTable, "function");
});

test("findAvailableTable dispatches by gameType", () => {
  assert.equal(typeof findAvailableTable, "function");
  assert.equal(typeof joinFixedCapacityWithRetry, "function");
  assert.equal(typeof findUserSeatedTable, "function");
});

// ── a player is at a table once, or not at all ───────────────────────────────
//
// Production kept raising `monitor_duplicate_seat_or_reservation` (critical) on
// a tarneeb41 table: the same user present across seats *and* the waiting
// queue. That check alerts and never repairs, by design — after the fact,
// which entry is authoritative is a guess. So the join has to not create it.

const { withoutQueuedUser } = require("../services/tableAllocationService");

const q = (...users) => users.map((u) => ({ user: u, buyIn: 1000 }));

test("seating a player drops the queue entry they were holding", () => {
  const out = withoutQueuedUser(q("a", "me", "b"), "me");
  assert.deepEqual(out.map((e) => e.user), ["a", "b"]);
});

test("everyone else keeps their place in the queue", () => {
  const out = withoutQueuedUser(q("a", "b"), "me");
  assert.deepEqual(out.map((e) => e.user), ["a", "b"]);
});

test("an ObjectId and its string form are the same player", () => {
  const oid = { toString: () => "507f1f77bcf86cd799439011" };
  const out = withoutQueuedUser(q(oid, "b"), "507f1f77bcf86cd799439011");
  assert.deepEqual(out.map((e) => e.user), ["b"]);
});

test("a duplicated queue entry is fully cleared, not just the first", () => {
  const out = withoutQueuedUser(q("me", "a", "me"), "me");
  assert.deepEqual(out.map((e) => e.user), ["a"]);
});

test("an empty or missing queue is handled without throwing", () => {
  assert.deepEqual(withoutQueuedUser([], "me"), []);
  assert.deepEqual(withoutQueuedUser(undefined, "me"), []);
  assert.deepEqual(withoutQueuedUser(null, "me"), []);
});
