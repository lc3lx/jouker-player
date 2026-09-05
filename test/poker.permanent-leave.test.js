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

test("remainingHumansAfterLeave is 0 when the leaver is the only seated human", () => {
  const { remainingHumansAfterLeave } = require("../services/pokerVacateService");
  const uid = "6a355901480bec8d89f85847";
  assert.equal(
    remainingHumansAfterLeave({ seats: [{ user: uid }], vacatingPlayers: [] }, uid),
    0
  );
  assert.equal(
    remainingHumansAfterLeave(
      { seats: [{ user: uid }, { user: "6a355901480bec8d89f85848" }], vacatingPlayers: [] },
      uid
    ),
    1
  );
  assert.equal(
    remainingHumansAfterLeave(
      {
        seats: [{ user: uid }],
        vacatingPlayers: [{ user: "other", vacateUntil: new Date(Date.now() + 30_000) }],
      },
      uid
    ),
    0,
    "vacate window does not keep the table alive"
  );
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
