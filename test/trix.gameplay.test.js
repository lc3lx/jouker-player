const test = require("node:test");
const assert = require("node:assert/strict");
const TrixGame = require("../games/trix/TrixGame");
const GameManager = require("../games/trix/managers/GameManager");
const RoundManager = require("../games/trix/managers/RoundManager");
const ScoreManager = require("../games/trix/managers/ScoreManager");

async function mkGame() {
  const game = new TrixGame("test_room", { mongoTableId: "test" });
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
  game.applyCosmeticsToPlayers = async () => {};
  await game.startGame();
  game.clearBotTimer();
  return game;
}

function selectGame(game, gameType) {
  const king = game.gameState.currentKingIndex;
  const r = game.applyMove(king, "select_game", {
    gameType,
    moveId: `sel_${gameType}_${Date.now()}`,
  });
  assert.equal(r.success, true, r.reason);
}

test("Diamonds — penalizes diamond cards taken", async () => {
  const game = await mkGame();
  selectGame(game, "Diamonds");
  const diamond = { rank: "7", suit: "Diamonds", value: 7 };
  game.gameState.players[0].takenCards = [diamond];
  game.gameState.players.forEach((p) => {
    p.hand = [];
  });
  ScoreManager.calculateRoundScore(game.gameState);
  assert.equal(game.gameState.scores[0], -10);
  game.destroy();
});

test("Queens — penalizes queens taken", async () => {
  const game = await mkGame();
  selectGame(game, "Queens");
  const queen = { rank: "Q", suit: "Spades", value: 12 };
  game.gameState.players[0].takenCards = [queen];
  game.gameState.players.forEach((p) => {
    p.hand = [];
  });
  ScoreManager.calculateRoundScore(game.gameState);
  assert.equal(game.gameState.scores[0], -25);
  game.destroy();
});

test("KingOfHearts — penalizes K of hearts", async () => {
  const game = await mkGame();
  selectGame(game, "KingOfHearts");
  game.gameState.players[1].takenCards = [{ rank: "K", suit: "Hearts", value: 13 }];
  game.gameState.players.forEach((p) => {
    p.hand = [];
  });
  ScoreManager.calculateRoundScore(game.gameState);
  assert.equal(game.gameState.scores[1], -75);
  game.destroy();
});

test("Tricks — penalizes tricks won", async () => {
  const game = await mkGame();
  selectGame(game, "Tricks");
  game.gameState.players[2].takenCards = Array.from({ length: 8 }, (_, i) => ({
    rank: "2",
    suit: "Clubs",
    value: 2 + i,
  }));
  game.gameState.players.forEach((p) => {
    p.hand = [];
  });
  ScoreManager.calculateRoundScore(game.gameState);
  assert.equal(game.gameState.scores[2], -30);
  game.destroy();
});

test("Trix — awards finish order points", async () => {
  const game = await mkGame();
  selectGame(game, "Trix");
  game.gameState.finishedPlayers = [0, 2, 1];
  game.gameState.players.forEach((p) => {
    p.hand = [];
  });
  ScoreManager.calculateRoundScore(game.gameState);
  assert.equal(game.gameState.scores[0], 200);
  assert.equal(game.gameState.scores[2], 150);
  assert.equal(game.gameState.scores[1], 100);
  assert.equal(game.gameState.scores[3], 50);
  game.destroy();
});

test("calculateRoundScore is idempotent within one contract", async () => {
  const game = await mkGame();
  selectGame(game, "Tricks");
  game.gameState.players[0].takenCards = Array.from({ length: 4 }, () => ({
    rank: "2",
    suit: "Clubs",
    value: 2,
  }));
  game.gameState.players.forEach((p) => {
    p.hand = [];
  });
  ScoreManager.calculateRoundScore(game.gameState);
  ScoreManager.calculateRoundScore(game.gameState); // must not double-apply
  assert.equal(game.gameState.scores[0], -15);
  assert.deepEqual(game.gameState.lastRoundDelta, [-15, 0, 0, 0]);
  game.destroy();
});

test("cumulative scores stay multiples of 5 across mixed contracts", async () => {
  const game = await mkGame();
  // Diamonds: P0 takes 2 diamonds → -20
  selectGame(game, "Diamonds");
  game.gameState.players[0].takenCards = [
    { rank: "A", suit: "Diamonds", value: 14 },
    { rank: "5", suit: "Diamonds", value: 5 },
  ];
  game.gameState.players.forEach((p) => {
    p.hand = [];
  });
  ScoreManager.calculateRoundScore(game.gameState);
  game.state = "round_end";
  game.nextRound();

  // Queens: P1 takes 1 queen → -25
  selectGame(game, "Queens");
  game.gameState.players[1].takenCards = [{ rank: "Q", suit: "Spades", value: 12 }];
  game.gameState.players.forEach((p) => {
    p.hand = [];
  });
  ScoreManager.calculateRoundScore(game.gameState);

  for (const s of game.gameState.scores) {
    assert.equal(Math.abs(s) % 5, 0, `score ${s} must be multiple of 5`);
  }
  assert.equal(game.gameState.scores[0], -20);
  assert.equal(game.gameState.scores[1], -25);
  game.destroy();
});

test("20-round king rotation — advances king after 5 games", async () => {
  const game = await mkGame();
  const startKing = game.gameState.currentKingIndex;
  for (let round = 0; round < 5; round += 1) {
    const available = RoundManager.getAvailableGames(game.gameState, game.gameState.currentKingIndex);
    selectGame(game, available[0]);
    game.gameState.players.forEach((p) => {
      p.hand = [];
      p.takenCards = [];
    });
    game.state = "round_end";
    game.nextRound();
  }
  assert.equal(game.gameState.currentKingIndex, (startKing + 1) % 4);
  game.destroy();
});

test("bot-timer game_end triggers afterMove gameEnded", async () => {
  const game = await mkGame();
  let gameEnded = false;
  game.setAfterMoveListener((r) => {
    if (r.gameEnded) gameEnded = true;
  });
  game.gameState.roundNumber = 20;
  game.state = "round_end";
  game.nextRound();
  assert.equal(game.state, "game_end");
  assert.equal(gameEnded, true);
  game.destroy();
});

test("resolveTrick stores lastTrick before clearing tableCards", async () => {
  const game = await mkGame();
  selectGame(game, "Tricks");
  const gs = game.gameState;
  const card = (rank, suit, value) => ({ rank, suit, value });
  gs.players[0].hand = [card("2", "Hearts", 2)];
  gs.players[1].hand = [card("3", "Hearts", 3)];
  gs.players[2].hand = [card("4", "Hearts", 4)];
  gs.players[3].hand = [card("5", "Hearts", 5)];
  gs.turnPlayerIndex = 0;
  assert.equal(GameManager.playCard(gs, 0, { rank: "2", suit: "Hearts" }).success, true);
  GameManager.nextTurn(gs);
  assert.equal(GameManager.playCard(gs, 1, { rank: "3", suit: "Hearts" }).success, true);
  GameManager.nextTurn(gs);
  assert.equal(GameManager.playCard(gs, 2, { rank: "4", suit: "Hearts" }).success, true);
  GameManager.nextTurn(gs);
  assert.equal(GameManager.playCard(gs, 3, { rank: "5", suit: "Hearts" }).success, true);
  assert.equal(gs.tableCards.length, 4);
  const result = GameManager.resolveTrick(gs);
  assert.ok(result);
  assert.equal(gs.tableCards.length, 0);
  assert.equal(gs.lastTrick.length, 4);
  assert.equal(gs.lastTrick[3].card.rank, "5");
  game.destroy();
});
