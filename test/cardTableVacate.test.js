const test = require("node:test");
const assert = require("node:assert/strict");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
const TrixGame = require("../games/trix/TrixGame");
const {
  cancelCardTableVacate,
  scheduleCardTableVacate,
  finalizeCardTableVacate,
  VACATE_MS,
  TRIX_VACATE_MS,
} = require("../services/cardTableVacateService");
const roomManager = require("../rooms/roomManager");

test("VACATE_MS defaults to 60 seconds for tarneeb41", () => {
  assert.equal(VACATE_MS, 60000);
});

test("TRIX_VACATE_MS defaults to 30 seconds", () => {
  assert.equal(TRIX_VACATE_MS, 30000);
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

test("humanCount stays > 0 during vacate grace (no empty seat)", () => {
  const game = new Tarneeb41Game("r1", { mongoTableId: "t_grace" });
  for (let i = 0; i < 4; i += 1) {
    game.players.push({
      userId: `u${i}`,
      socketId: i === 1 ? null : `s${i}`,
      seatIndex: i,
      isBot: false,
      displayName: `Human ${i}`,
      chips: 1000,
    });
  }
  game.players[1].reconnectDeadline = Date.now() + 20000;
  game.players[1].socketId = null;
  assert.equal(game.humanCount(), 4);
  game.destroy();
});

test("finalizeCardTableVacate replaces disconnected human with bot during bidding", async () => {
  const tableId = `bid_vacate_${Date.now()}`;
  const game = new Tarneeb41Game("r1", { mongoTableId: tableId });
  game.state = "bidding_syrian";
  game.declaredBids = [null, null, null, null];
  game.currentPlayerIndex = 1;
  game.hands = [[], [], [], []];
  for (let i = 0; i < 4; i += 1) {
    game.players.push({
      userId: `u${i}`,
      socketId: `s${i}`,
      seatIndex: i,
      isBot: false,
      displayName: `Human ${i}`,
      chips: 1000,
    });
  }
  roomManager.tarneeb41GamesByTableId.set(tableId, game);
  game.players[1].socketId = null;
  game.players[1].reconnectDeadline = Date.now() - 1;

  await finalizeCardTableVacate({
    gameType: "tarneeb41",
    tableId,
    userId: "u1",
    nsp: { sockets: new Map() },
  });

  assert.equal(game.players[1].isBot, true);
  assert.equal(game.players[1].vacatedFromUserId, "u1");
  assert.equal(game.humanCount(), 3);

  game.destroy();
  roomManager.tarneeb41GamesByTableId.delete(tableId);
});

test("restoreHumanAtSeat only allows the original vacated user", () => {
  const game = new Tarneeb41Game("r1", { mongoTableId: "t_restore" });
  game.players.push({
    userId: "bot_vacate_1",
    socketId: null,
    seatIndex: 0,
    isBot: true,
    displayName: "بوت",
    chips: 1000,
    vacatedFromUserId: "u1",
  });
  assert.equal(game.restoreHumanAtSeat(0, "u1", "sock_new", "Ali"), true);
  assert.equal(game.players[0].isBot, false);
  assert.equal(game.players[0].userId, "u1");

  game.convertHumanToBot("u1");
  assert.equal(game.restoreHumanAtSeat(0, "u2", "sock_other", "Other"), false);

  game.destroy();
});

test("TrixGame.restoreHumanAtSeat only allows the original vacated user", () => {
  const game = new TrixGame("r1", { mongoTableId: "t_trix_restore" });
  game.players.push({
    userId: "bot_vacate_1",
    socketId: null,
    seatIndex: 0,
    isBot: true,
    displayName: "بوت",
    chips: 1000,
    vacatedFromUserId: "u1",
  });
  assert.equal(game.restoreHumanAtSeat(0, "u1", "sock_new", "Ali"), true);
  assert.equal(game.players[0].isBot, false);
  assert.equal(game.players[0].userId, "u1");
  game.destroy();
});

test("Trix checkBotTurn Trix skip notifies state listener", () => {
  const game = new TrixGame("r1", { mongoTableId: "t_skip" });
  for (let i = 0; i < 4; i += 1) {
    game.players.push({
      userId: `u${i}`,
      socketId: `s${i}`,
      seatIndex: i,
      isBot: true,
      displayName: `P${i}`,
      chips: 1000,
    });
  }
  game.startGame();
  game.clearBotTimer();
  const king = game.gameState.currentKingIndex;
  game.applyMove(king, "select_game", {
    gameType: "Trix",
    moveId: "sel_trix_1",
  });
  let broadcasts = 0;
  game.setStateChangedListener(() => {
    broadcasts += 1;
  });
  game.gameState.turnPlayerIndex = 0;
  game.gameState.players[0].hand = [];
  game.checkBotTurn();
  assert.ok(broadcasts > 0, "state listener should fire when Trix turn skips");
  game.destroy();
});

test("onCardTableRejoin does not cancel vacate after grace expired", () => {
  const { onCardTableRejoin } = require("../services/cardTableVacateService");
  const tableId = `no_cancel_${Date.now()}`;
  const game = new TrixGame("r1", { mongoTableId: tableId });
  game.players.push({
    userId: "u1",
    socketId: null,
    seatIndex: 0,
    isBot: false,
    displayName: "Human",
    chips: 1000,
    reconnectDeadline: Date.now() - 1000,
  });
  roomManager.trixGamesByTableId.set(tableId, game);

  onCardTableRejoin({ gameType: "trix", tableId, userId: "u1" });
  assert.ok(game.players[0].reconnectDeadline < Date.now());

  game.destroy();
  roomManager.trixGamesByTableId.delete(tableId);
});

test("finalizeCardTableVacate clears trix game when last human times out", async () => {
  const tableId = `last_human_${Date.now()}`;
  const game = new TrixGame("r1", { mongoTableId: tableId });
  game.state = "playing";
  game.gameState = { turnPlayerIndex: 0 };
  game.players.push({
    userId: "u1",
    socketId: null,
    seatIndex: 0,
    isBot: false,
    displayName: "Human",
    chips: 1000,
    reconnectDeadline: Date.now() - 1000,
  });
  for (let i = 1; i < 4; i += 1) {
    game.players.push({
      userId: `bot_${i}`,
      socketId: null,
      seatIndex: i,
      isBot: true,
      displayName: "بوت",
      chips: 0,
    });
  }
  roomManager.trixGamesByTableId.set(String(tableId), game);

  await finalizeCardTableVacate({
    gameType: "trix",
    tableId,
    userId: "u1",
    nsp: { sockets: new Map() },
  });

  assert.equal(roomManager.getTrixGameForTable(String(tableId)), null);
  assert.equal(game.players[0].isBot, true);
  assert.equal(game.humanCount(), 0);

  roomManager.userToTrixTableId.delete("u1");
});

test("getGameState exposes reconnectDeadline on disconnected seat", () => {
  const game = new Tarneeb41Game("r1", { mongoTableId: "t_deadline" });
  const deadline = Date.now() + 15000;
  game.players.push({
    userId: "u1",
    socketId: null,
    seatIndex: 0,
    isBot: false,
    displayName: "Human",
    chips: 1000,
    reconnectDeadline: deadline,
  });
  game.state = "bidding_syrian";
  const state = game.getGameState(0);
  assert.equal(state.seatsPublic[0].reconnectDeadline, deadline);
  assert.equal(state.seatsPublic[0].isBot, false);
  game.destroy();
});

test("game_end getGameState replays settlement failure marker", () => {
  const game = new Tarneeb41Game("r1", { mongoTableId: "t_fail" });
  game.state = "game_end";
  game.playerScores = [41, 10, 5, 8];
  game._lastSettlementFailure = { reason: "RECONCILIATION_FAILED" };
  game.players = Array.from({ length: 4 }, (_, i) => ({
    userId: `u${i}`,
    socketId: `s${i}`,
    seatIndex: i,
    isBot: false,
    displayName: `H${i}`,
    chips: 1000,
  }));
  const state = game.getGameState(0);
  assert.equal(state.winnerTeam, 0);
  assert.ok(game._lastSettlementFailure);
  game.destroy();
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
