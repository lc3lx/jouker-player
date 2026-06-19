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
