const test = require("node:test");
const assert = require("node:assert/strict");
const TrixGame = require("../games/trix/TrixGame");

function mkGame() {
  const game = new TrixGame("conc", { mongoTableId: "conc" });
  for (let i = 0; i < 4; i += 1) {
    game.players.push({
      userId: `u${i}`,
      socketId: `s${i}`,
      seatIndex: i,
      isBot: i >= 2,
      displayName: `P${i}`,
      chips: 1000,
    });
  }
  game.startGame();
  game.clearBotTimer();
  const king = game.gameState.currentKingIndex;
  game.applyMove(king, "select_game", { gameType: "Tricks", moveId: "init_sel" });
  return game;
}

test("duplicate moveId returns duplicate without double-playing", () => {
  const game = mkGame();
  try {
    const idx = game.gameState.turnPlayerIndex;
    const hand = game.gameState.players[idx].hand;
    const card = hand[0];
    const payload = {
      card: { rank: card.rank, suit: card.suit },
      moveId: "dup_move_1",
    };
    const first = game.applyMove(idx, "play_card", payload);
    assert.equal(first.success, true);
    assert.equal(first.duplicate, undefined);
    const handLenAfterFirst = game.gameState.players[idx].hand.length;

    const second = game.applyMove(idx, "play_card", payload);
    assert.equal(second.success, true);
    assert.equal(second.duplicate, true);
    assert.equal(game.gameState.players[idx].hand.length, handLenAfterFirst);
  } finally {
    game.destroy();
  }
});

test("stale play_card rejected when not your turn", () => {
  const game = mkGame();
  try {
    const turn = game.gameState.turnPlayerIndex;
    const notTurn = (turn + 1) % 4;
    const card = game.gameState.players[notTurn].hand[0];
    const result = game.applyMove(notTurn, "play_card", {
      card: { rank: card.rank, suit: card.suit },
      moveId: "stale_1",
    });
    assert.equal(result.success, false);
    assert.match(result.reason, /turn/i);
  } finally {
    game.destroy();
  }
});

test("duplicate select_game moveId is idempotent", () => {
  const game = mkGame();
  try {
    game.state = "selecting_game";
    game.gameState.currentGameType = null;
    game.gameState.roundNumber = 0;
    const king = game.gameState.currentKingIndex;
    const payload = { gameType: "Diamonds", moveId: "sel_dup_1" };
    const first = game.applyMove(king, "select_game", payload);
    assert.equal(first.success, true);
    const roundAfter = game.gameState.roundNumber;
    const second = game.applyMove(king, "select_game", payload);
    assert.equal(second.duplicate, true);
    assert.equal(game.gameState.roundNumber, roundAfter);
  } finally {
    game.destroy();
  }
});
