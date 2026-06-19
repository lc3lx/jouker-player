const test = require("node:test");
const assert = require("node:assert/strict");
const TrixGame = require("../games/trix/TrixGame");
const roomManager = require("../rooms/roomManager");

function mkFinishedGame(tableId) {
  const game = new TrixGame(`room_${tableId}`, { mongoTableId: tableId });
  for (let i = 0; i < 4; i += 1) {
    game.players.push({
      userId: i < 2 ? `human_${i}` : `bot_${i}`,
      socketId: i < 2 ? `sock_${i}` : null,
      seatIndex: i,
      isBot: i >= 2,
      displayName: i >= 2 ? "بوت" : `Human ${i}`,
      chips: 1000,
    });
  }
  game.gameState = {
    scores: [100, 80, 60, 40],
    players: [],
  };
  game.state = "game_end";
  game._finishedAt = Date.now();
  game._settlementCompleted = false;
  game.botInterval = setInterval(() => {}, 60_000);
  game.turnTimerInterval = setInterval(() => {}, 60_000);
  roomManager.trixGamesByTableId.set(String(tableId), game);
  return game;
}

function cleanupTable(tableId) {
  const game = roomManager.getTrixGameForTable(tableId);
  if (game && typeof game.destroy === "function") game.destroy();
  roomManager.trixGamesByTableId.delete(String(tableId));
  for (const uid of ["human_0", "human_1"]) {
    roomManager.userToTrixTableId.delete(uid);
    roomManager.trixUserSocket.delete(uid);
  }
}

test("clearTrixGame after settlement when all humans left", () => {
  const tableId = `trix_life_${Date.now()}`;
  const game = mkFinishedGame(tableId);
  try {
    roomManager.setUserTrixTable("human_0", tableId);
    roomManager.setUserTrixTable("human_1", tableId);
    roomManager.markTrixSettlementComplete(tableId);

    assert.equal(roomManager.tryClearTrixGameIfReady(tableId).cleared, false);

    roomManager.leaveTrixTableSocket("human_0");
    assert.ok(roomManager.getTrixGameForTable(tableId));

    roomManager.leaveTrixTableSocket("human_1");
    assert.equal(roomManager.getTrixGameForTable(tableId), null);
    assert.equal(game.botInterval, null);
    assert.equal(game.turnTimerInterval, null);
  } finally {
    cleanupTable(tableId);
  }
});

test("clearTrixGame blocked before settlement completes", () => {
  const tableId = `trix_pending_${Date.now()}`;
  mkFinishedGame(tableId);
  try {
    const result = roomManager.tryClearTrixGameIfReady(tableId);
    assert.equal(result.cleared, false);
    assert.equal(result.reason, "settlement_pending");
  } finally {
    cleanupTable(tableId);
  }
});

test("TTL fallback evicts expired finished games", () => {
  const tableId = `trix_ttl_${Date.now()}`;
  const prev = process.env.GAME_TTL_AFTER_FINISH_MINUTES;
  process.env.GAME_TTL_AFTER_FINISH_MINUTES = "10";
  const game = mkFinishedGame(tableId);
  try {
    game._finishedAt = Date.now() - 11 * 60 * 1000;
    const evicted = roomManager.evictExpiredTrixGames();
    assert.equal(evicted, 1);
    assert.equal(roomManager.getTrixGameForTable(tableId), null);
    assert.equal(game.botInterval, null);
  } finally {
    if (prev === undefined) delete process.env.GAME_TTL_AFTER_FINISH_MINUTES;
    else process.env.GAME_TTL_AFTER_FINISH_MINUTES = prev;
    cleanupTable(tableId);
  }
});

test("clearTrixGame is idempotent", () => {
  const tableId = `trix_dup_${Date.now()}`;
  mkFinishedGame(tableId);
  try {
    const first = roomManager.clearTrixGame(tableId);
    assert.equal(first.cleared, true);
    const second = roomManager.clearTrixGame(tableId);
    assert.equal(second.cleared, false);
    assert.equal(second.reason, "already_cleared");
  } finally {
    cleanupTable(tableId);
  }
});

test("destroy clears timers — no memory leak handles", () => {
  const game = new TrixGame("leak_test", { mongoTableId: "leak" });
  game.botInterval = setInterval(() => {}, 60_000);
  game.turnTimerInterval = setInterval(() => {}, 60_000);
  game.destroy();
  assert.equal(game.botInterval, null);
  assert.equal(game.turnTimerInterval, null);
});

test("countConnectedHumansAtTrixTable tracks active sockets only", () => {
  const tableId = `trix_conn_${Date.now()}`;
  const game = mkFinishedGame(tableId);
  game.state = "playing";
  try {
    roomManager.setUserTrixTable("human_0", tableId);
    roomManager.setTrixUserSocket("human_0", "sock_0");
    assert.equal(roomManager.countConnectedHumansAtTrixTable(tableId), 1);
    roomManager.deleteTrixUserSocket("human_0");
    assert.equal(roomManager.countConnectedHumansAtTrixTable(tableId), 0);
    assert.ok(roomManager.countHumansAtTrixTable(tableId) > 0, "mapping may linger until abandon");
  } finally {
    cleanupTable(tableId);
  }
});
