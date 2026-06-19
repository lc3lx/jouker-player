const test = require("node:test");
const assert = require("node:assert/strict");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
const roomManager = require("../rooms/roomManager");

function mkFinishedGame(tableId) {
  const game = new Tarneeb41Game(`room_${tableId}`, { mongoTableId: tableId });
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
  game.state = "game_end";
  game._finishedAt = Date.now();
  game.botInterval = setInterval(() => {}, 60_000);
  game.turnTimerInterval = setInterval(() => {}, 60_000);
  game.onGameEvent = () => {};
  game.onAfterMove = () => {};
  roomManager.tarneeb41GamesByTableId.set(String(tableId), game);
  return game;
}

function cleanupTable(tableId) {
  const game = roomManager.getTarneeb41GameForTable(tableId);
  if (game && typeof game.destroy === "function") game.destroy();
  roomManager.tarneeb41GamesByTableId.delete(String(tableId));
  for (const uid of ["human_0", "human_1", "u0", "u1", "leave_u"]) {
    if (roomManager.getTarneeb41TableIdForUser(uid) === String(tableId)) {
      roomManager.userToTarneeb41TableId.delete(uid);
    }
    roomManager.tarneeb41UserSocket.delete(uid);
  }
}

test("clearTarneeb41Game after settlement when all humans left", () => {
  const tableId = `life_settle_${Date.now()}`;
  const game = mkFinishedGame(tableId);
  try {
    roomManager.setUserTarneeb41Table("human_0", tableId);
    roomManager.setUserTarneeb41Table("human_1", tableId);
    roomManager.markTarneeb41SettlementComplete(tableId);

    assert.equal(roomManager.tryClearTarneeb41GameIfReady(tableId).cleared, false);

    roomManager.leaveTarneeb41TableSocket("human_0");
    assert.equal(roomManager.getTarneeb41GameForTable(tableId) != null, true);

    roomManager.leaveTarneeb41TableSocket("human_1");
    assert.equal(roomManager.getTarneeb41GameForTable(tableId), null);
    assert.equal(game.botInterval, null);
    assert.equal(game.turnTimerInterval, null);
    assert.equal(game.onGameEvent, null);
    assert.equal(game.onAfterMove, null);
  } finally {
    cleanupTable(tableId);
  }
});

test("clearTarneeb41Game does not run before settlement completes", () => {
  const tableId = `life_pending_${Date.now()}`;
  mkFinishedGame(tableId);
  try {
    const result = roomManager.tryClearTarneeb41GameIfReady(tableId);
    assert.equal(result.cleared, false);
    assert.equal(result.reason, "settlement_pending");
    assert.ok(roomManager.getTarneeb41GameForTable(tableId) != null);
  } finally {
    cleanupTable(tableId);
  }
});

test("clearTarneeb41Game after TTL fallback", () => {
  const tableId = `life_ttl_${Date.now()}`;
  const prev = process.env.GAME_TTL_AFTER_FINISH_MINUTES;
  process.env.GAME_TTL_AFTER_FINISH_MINUTES = "10";
  const game = mkFinishedGame(tableId);
  try {
    game._finishedAt = Date.now() - 11 * 60 * 1000;
    const evicted = roomManager.evictExpiredTarneeb41Games();
    assert.equal(evicted, 1);
    assert.equal(roomManager.getTarneeb41GameForTable(tableId), null);
    assert.equal(game.botInterval, null);
    assert.equal(game.turnTimerInterval, null);
  } finally {
    if (prev === undefined) delete process.env.GAME_TTL_AFTER_FINISH_MINUTES;
    else process.env.GAME_TTL_AFTER_FINISH_MINUTES = prev;
    cleanupTable(tableId);
  }
});

test("clearTarneeb41Game is idempotent on duplicate calls", () => {
  const tableId = `life_dup_${Date.now()}`;
  mkFinishedGame(tableId);
  try {
    const first = roomManager.clearTarneeb41Game(tableId);
    assert.equal(first.cleared, true);
    const second = roomManager.clearTarneeb41Game(tableId);
    assert.equal(second.cleared, false);
    assert.equal(second.reason, "already_cleared");
    assert.doesNotThrow(() => roomManager.clearTarneeb41Game(tableId));
  } finally {
    cleanupTable(tableId);
  }
});
