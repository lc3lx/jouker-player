const test = require("node:test");
const assert = require("node:assert/strict");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
const TrixGame = require("../games/trix/TrixGame");
const {
  cancelCardTableVacate,
  scheduleCardTableVacate,
  VACATE_MS,
} = require("../services/cardTableVacateService");
const roomManager = require("../rooms/roomManager");

test("VACATE_MS defaults to 30 seconds", () => {
  assert.equal(VACATE_MS, 30000);
});

test("Tarneeb41Game.convertHumanToBot preserves seat and enables bot play", () => {
  const game = new Tarneeb41Game("r1", { mongoTableId: "t1" });
  game.players.push({
    userId: "u1",
    socketId: "s1",
    seatIndex: 0,
    isBot: false,
    displayName: "Human",
    chips: 1000,
  });
  assert.equal(game.humanCount(), 1);
  assert.equal(game.convertHumanToBot("u1"), true);
  assert.equal(game.humanCount(), 0);
  assert.equal(game.players[0].isBot, true);
  game.destroy();
});

test("TrixGame.convertHumanToBot works", () => {
  const game = new TrixGame("r1", { mongoTableId: "t1" });
  game.players.push({
    userId: "u1",
    socketId: "s1",
    seatIndex: 0,
    isBot: false,
    displayName: "Human",
    chips: 1000,
  });
  assert.equal(game.humanCount(), 1);
  assert.equal(game.convertHumanToBot("u1"), true);
  assert.equal(game.humanCount(), 0);
  game.destroy();
});

test("scheduleCardTableVacate sets reconnectDeadline and can be cancelled on rejoin", () => {
  const tableId = `vacate_${Date.now()}`;
  const game = new Tarneeb41Game("r1", { mongoTableId: tableId });
  game.players.push({
    userId: "u1",
    socketId: "s1",
    seatIndex: 0,
    isBot: false,
    displayName: "Human",
    chips: 1000,
  });
  roomManager.tarneeb41GamesByTableId.set(tableId, game);
  roomManager.setUserTarneeb41Table("u1", tableId);

  const fakeNsp = { sockets: new Map() };
  scheduleCardTableVacate({
    gameType: "tarneeb41",
    tableId,
    userId: "u1",
    nsp: fakeNsp,
  });
  assert.ok(game.players[0].reconnectDeadline > Date.now());

  cancelCardTableVacate({ gameType: "tarneeb41", tableId, userId: "u1" });
  assert.equal(game.players[0].reconnectDeadline, null);

  game.destroy();
  roomManager.tarneeb41GamesByTableId.delete(tableId);
  roomManager.userToTarneeb41TableId.delete("u1");
});

test("abandonTrixTableIfNoHumans waits while human is in vacate grace", async () => {
  const { abandonTrixTableIfNoHumans } = require("../services/trixRecoveryService");
  const tableId = `grace_${Date.now()}`;
  const game = new TrixGame("r1", { mongoTableId: tableId });
  game.players.push({
    userId: "u1",
    socketId: null,
    seatIndex: 0,
    isBot: false,
    displayName: "Human",
    chips: 1000,
    reconnectDeadline: Date.now() + 25000,
  });
  roomManager.trixGamesByTableId.set(tableId, game);

  const result = await abandonTrixTableIfNoHumans(tableId);
  assert.equal(result.abandoned, false);
  assert.equal(result.reason, "humans_in_game");

  game.destroy();
  roomManager.trixGamesByTableId.delete(tableId);
});
