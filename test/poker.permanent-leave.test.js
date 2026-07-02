const { test } = require("node:test");
const assert = require("node:assert/strict");

test("permanentLeavePokerTable is exported", () => {
  const svc = require("../services/pokerVacateService");
  assert.equal(typeof svc.permanentLeavePokerTable, "function");
});

test("removeLiveHumanSeat is exported from table game bridge", () => {
  const bridge = require("../sockets/tableGame");
  assert.equal(typeof bridge.removeLiveHumanSeat, "function");
});
