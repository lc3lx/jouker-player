const test = require("node:test");
const assert = require("node:assert/strict");
const TrixGame = require("../games/trix/TrixGame");
const roomManager = require("../rooms/roomManager");

function mkGame({ tableId = "rc_trix" } = {}) {
  const game = new TrixGame(`room_${tableId}`, { mongoTableId: tableId });
  for (let i = 0; i < 4; i += 1) {
    game.players.push({
      userId: `u${i}`,
      socketId: `sock_${i}`,
      seatIndex: i,
      isBot: i >= 2,
      displayName: `P${i}`,
      chips: 1000,
    });
  }
  game.startGame();
  game.clearBotTimer();
  return game;
}

function simulateReconnect(game, userId, newSocketId) {
  roomManager.setTrixUserSocket(userId, newSocketId);
  game.syncLobbyFromTable(
    {
      seats: game.players
        .filter((p) => !p.isBot)
        .map((p) => ({ user: { _id: p.userId, name: p.displayName }, chips: 1000 })),
    },
    (uid) => roomManager.getTrixUserSocket(String(uid))
  );
  const seatIndex = game.getPlayerIndex(userId);
  const state = seatIndex >= 0 ? game.getGameState(seatIndex) : null;
  return { seatIndex, state, restarted: game.needsInitialDeal() };
}

test("reconnect during selecting_game preserves state", () => {
  const game = mkGame();
  try {
    assert.equal(game.state, "selecting_game");
    const beforeKing = game.gameState.currentKingIndex;
    const { seatIndex, state, restarted } = simulateReconnect(game, "u0", "sock_new_0");
    assert.equal(restarted, false);
    assert.equal(seatIndex, 0);
    assert.equal(state.state, "selecting_game");
    assert.equal(state.currentKingIndex, beforeKing);
    assert.ok(Array.isArray(state.hands[0]));
  } finally {
    game.destroy();
  }
});

test("reconnect during playing restores hand and trick", () => {
  const game = mkGame();
  try {
    const king = game.gameState.currentKingIndex;
    game.applyMove(king, "select_game", {
      gameType: "Tricks",
      moveId: "rc_sel_1",
    });
    assert.equal(game.state, "playing");
    const handBefore = game.gameState.players[0].hand.length;
    game.gameState.tableCards.push({
      playerIndex: 1,
      card: { rank: "7", suit: "Spades", value: 7 },
    });
    const { state, restarted } = simulateReconnect(game, "u0", "sock_new_0");
    assert.equal(restarted, false);
    assert.equal(state.state, "playing");
    assert.equal(state.hands[0].length, handBefore);
    assert.equal(state.tableCards.length, 1);
    assert.equal(state.currentGameType, "Tricks");
  } finally {
    game.destroy();
  }
});

test("reconnect during round_end preserves scores", () => {
  const game = mkGame();
  try {
    game.state = "round_end";
    game.gameState.scores = [10, 20, 30, 40];
    const { state } = simulateReconnect(game, "u1", "sock_new_1");
    assert.equal(state.state, "round_end");
    assert.deepEqual(state.scores, [10, 20, 30, 40]);
  } finally {
    game.destroy();
  }
});

test("reconnect during game_end preserves final scores", () => {
  const game = mkGame();
  try {
    game.state = "game_end";
    game.gameState.scores = [500, 400, 300, 200];
    game._lastSettlementPayload = { settlementId: "s1", totalPayout: 1000 };
    const { state } = simulateReconnect(game, "u0", "sock_new_0");
    assert.equal(state.state, "game_end");
    assert.deepEqual(state.scores, [500, 400, 300, 200]);
  } finally {
    game.destroy();
  }
});

test("reconnect does not restart in-progress game", () => {
  const game = mkGame();
  try {
    const sessionBefore = game.sessionId;
    game.applyMove(game.gameState.currentKingIndex, "select_game", {
      gameType: "Diamonds",
      moveId: "rc_no_restart",
    });
    const { restarted } = simulateReconnect(game, "u0", "sock_x");
    assert.equal(restarted, false);
    assert.equal(game.sessionId, sessionBefore);
    assert.equal(game.gameState.roundNumber, 1);
  } finally {
    game.destroy();
  }
});
