/**
 * Lazy bridge to tableGame exports — avoids circular require capturing undefined
 * when pokerTableGcService / pokerTableAllocationService load before tableGame finishes.
 */
function bridge() {
  return require("./tableGame");
}

function call(name, ...args) {
  const fn = bridge()[name];
  if (typeof fn !== "function") return null;
  return fn(...args);
}

module.exports = {
  getTableGameDebugSnapshot: (tableId) => call("getTableGameDebugSnapshot", tableId),
  evictTableFromRegistry: (tableId) => call("evictTableFromRegistry", tableId),
  resetLivePokerTableWhenEmpty: (tableId) => call("resetLivePokerTableWhenEmpty", tableId),
  syncLivePokerTableAfterJoin: (tableId) => call("syncLivePokerTableAfterJoin", tableId),
  syncLivePokerTableAfterLeave: (tableId) => call("syncLivePokerTableAfterLeave", tableId),
  vacateLiveEngineSeat: (tableId, userId, opts) => call("vacateLiveEngineSeat", tableId, userId, opts),
  restoreLiveEngineSeat: (tableId, userId, data) => call("restoreLiveEngineSeat", tableId, userId, data),
  removeLiveHumanSeat: (tableId, userId) => call("removeLiveHumanSeat", tableId, userId),
  adminForceEndHandTable: (tableId) => call("adminForceEndHandTable", tableId),
};
