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

test("userCannotRejoinPokerTable is true after a permanent leave block", () => {
  const { userCannotRejoinPokerTable, isUserRejoinBlocked } = require("../services/pokerVacateService");
  const uid = "6a355901480bec8d89f85847";
  const table = {
    pendingPermanentLeaves: [],
    rejoinBlockedUsers: [{ user: uid, blockedAt: new Date() }],
  };
  assert.equal(isUserRejoinBlocked(table, uid), true);
  assert.equal(userCannotRejoinPokerTable(table, uid), true);
  assert.equal(userCannotRejoinPokerTable(table, "other"), false);
});
