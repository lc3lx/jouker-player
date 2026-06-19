const test = require("node:test");
const assert = require("node:assert/strict");
const TrixGame = require("../games/trix/TrixGame");

function mkGame() {
  const game = new TrixGame("iso", { mongoTableId: "iso" });
  for (let i = 0; i < 4; i += 1) {
    game.players.push({
      userId: `u${i}`,
      socketId: `s${i}`,
      seatIndex: i,
      isBot: false,
      displayName: `P${i}`,
      chips: 1000,
    });
  }
  game.startGame();
  game.clearBotTimer();
  return game;
}

function assertNoRealCards(hand) {
  for (const c of hand) {
    assert.equal(c, null, "opponent card must be null placeholder");
  }
}

test("getGameState masks opponent hands", () => {
  const game = mkGame();
  try {
    for (let viewer = 0; viewer < 4; viewer += 1) {
      const state = game.getGameState(viewer);
      for (let i = 0; i < 4; i += 1) {
        if (i === viewer) {
          assert.ok(state.hands[i].every((c) => c && c.rank && c.suit));
        } else {
          assertNoRealCards(state.hands[i]);
          assert.equal(state.hands[i].length, game.gameState.players[i].hand.length);
        }
      }
    }
  } finally {
    game.destroy();
  }
});

test("getGameState never exposes deck or takenCards", () => {
  const game = mkGame();
  try {
    game.gameState.players[0].takenCards = [{ rank: "K", suit: "Hearts", value: 13 }];
    const state = game.getGameState(1);
    const serialized = JSON.stringify(state);
    assert.ok(!serialized.includes('"takenCards"'));
    assert.ok(!serialized.includes('"deck"'));
  } finally {
    game.destroy();
  }
});

test("validCards only for requesting player", () => {
  const game = mkGame();
  try {
    const king = game.gameState.currentKingIndex;
    game.applyMove(king, "select_game", { gameType: "Trix", moveId: "iso_trix" });
    const turn = game.gameState.turnPlayerIndex;
    const forTurn = game.getGameState(turn);
    const forOther = game.getGameState((turn + 1) % 4);
    assert.ok(Array.isArray(forTurn.validCards));
    assert.equal(forOther.validCards.length, 0);
  } finally {
    game.destroy();
  }
});
