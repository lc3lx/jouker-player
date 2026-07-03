const test = require('node:test');
const assert = require('node:assert/strict');
const TrixGame = require('../games/trix/TrixGame');

// Builds a 4-player Trix game with bot timer disabled.
function mkGame() {
  const game = new TrixGame('score_e2e_room', { mongoTableId: 'test' });
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
  game.clearTurnTimer();
  return game;
}

function card(rank, suit) {
  const values = {
    2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10,
    J: 11, Q: 12, K: 13, A: 14,
  };
  return { rank, suit, value: values[rank] };
}

// Forces a contract selection by seat 0 (set as king) and returns the game.
function startContract(game, gameType) {
  game.gameState.currentKingIndex = 0;
  const r = game.applyMove(0, 'select_game', {
    gameType,
    moveId: `sel_${gameType}`,
  });
  assert.equal(r.success, true, r.reason);
  game.clearTurnTimer();
}

// Plays one card for the current turn player through the real engine.
function play(game, rank, suit) {
  const pi = game.gameState.turnPlayerIndex;
  const r = game.applyMove(pi, 'play_card', {
    card: { rank, suit },
    moveId: `mv_${pi}_${rank}_${suit}_${Math.random()}`,
  });
  assert.equal(r.success, true, r.reason || 'play rejected');
  game.clearTurnTimer();
  return r;
}

test('Diamonds e2e — winner of a trick with 2 diamonds loses 20', () => {
  const game = mkGame();
  startContract(game, 'Diamonds');
  game.gameState.turnPlayerIndex = 0;
  game.gameState.leadingSuit = null;
  game.gameState.tableCards = [];
  game.gameState.players[0].hand = [card('A', 'Diamonds')];
  game.gameState.players[1].hand = [card('5', 'Diamonds')];
  game.gameState.players[2].hand = [card('3', 'Clubs')];
  game.gameState.players[3].hand = [card('2', 'Clubs')];

  play(game, 'A', 'Diamonds'); // P0 leads diamonds
  play(game, '5', 'Diamonds'); // P1 follows
  play(game, '3', 'Clubs'); // P2 off-suit
  play(game, '2', 'Clubs'); // P3 off-suit → P0 wins (A♦ high)

  assert.equal(game.state, 'round_end');
  // P0 took A♦ + 5♦ = 2 diamonds → -20
  assert.equal(game.gameState.scores[0], -20);
  assert.equal(game.gameState.scores[1], 0);
  assert.equal(game.gameState.scores[2], 0);
  assert.equal(game.gameState.scores[3], 0);
  game.destroy();
});

test('Tricks e2e — winner of one trick loses 15', () => {
  const game = mkGame();
  startContract(game, 'Tricks');
  game.gameState.turnPlayerIndex = 0;
  game.gameState.leadingSuit = null;
  game.gameState.tableCards = [];
  game.gameState.players[0].hand = [card('A', 'Spades')];
  game.gameState.players[1].hand = [card('K', 'Spades')];
  game.gameState.players[2].hand = [card('2', 'Spades')];
  game.gameState.players[3].hand = [card('3', 'Spades')];

  play(game, 'A', 'Spades'); // P0 leads
  play(game, 'K', 'Spades');
  play(game, '2', 'Spades');
  play(game, '3', 'Spades'); // P0 wins the single trick

  assert.equal(game.state, 'round_end');
  assert.equal(game.gameState.scores[0], -15); // 1 trick × -15
  assert.equal(game.gameState.scores[1], 0);
  game.destroy();
});

test('Queens e2e — taking a queen loses 25', () => {
  const game = mkGame();
  startContract(game, 'Queens');
  game.gameState.turnPlayerIndex = 0;
  game.gameState.leadingSuit = null;
  game.gameState.tableCards = [];
  game.gameState.players[0].hand = [card('A', 'Hearts')];
  game.gameState.players[1].hand = [card('Q', 'Hearts')];
  game.gameState.players[2].hand = [card('2', 'Hearts')];
  game.gameState.players[3].hand = [card('3', 'Hearts')];

  play(game, 'A', 'Hearts'); // P0 leads, wins
  play(game, 'Q', 'Hearts'); // queen falls to P0
  play(game, '2', 'Hearts');
  play(game, '3', 'Hearts');

  assert.equal(game.state, 'round_end');
  assert.equal(game.gameState.scores[0], -25); // took Q♥
  game.destroy();
});

test('KingOfHearts e2e — taking K of hearts loses 75', () => {
  const game = mkGame();
  startContract(game, 'KingOfHearts');
  game.gameState.turnPlayerIndex = 0;
  game.gameState.leadingSuit = null;
  game.gameState.tableCards = [];
  game.gameState.players[0].hand = [card('A', 'Hearts')];
  game.gameState.players[1].hand = [card('K', 'Hearts')];
  game.gameState.players[2].hand = [card('2', 'Hearts')];
  game.gameState.players[3].hand = [card('3', 'Hearts')];

  play(game, 'A', 'Hearts'); // P0 wins
  play(game, 'K', 'Hearts'); // K♥ falls to P0
  play(game, '2', 'Hearts');
  play(game, '3', 'Hearts');

  assert.equal(game.state, 'round_end');
  assert.equal(game.gameState.scores[0], -75);
  game.destroy();
});

test('Trix e2e — finish order awards 200/150/100/50', () => {
  const game = mkGame();
  startContract(game, 'Trix');
  game.gameState.turnPlayerIndex = 0;
  game.gameState.players[0].hand = [card('J', 'Spades')];
  game.gameState.players[1].hand = [card('J', 'Hearts')];
  game.gameState.players[2].hand = [card('J', 'Diamonds')];
  game.gameState.players[3].hand = [card('J', 'Clubs')];

  play(game, 'J', 'Spades'); // P0 finishes 1st
  play(game, 'J', 'Hearts'); // P1 finishes 2nd
  play(game, 'J', 'Diamonds'); // P2 finishes 3rd → round over, P3 gets 4th

  assert.equal(game.state, 'round_end');
  assert.equal(game.gameState.scores[0], 200);
  assert.equal(game.gameState.scores[1], 150);
  assert.equal(game.gameState.scores[2], 100);
  assert.equal(game.gameState.scores[3], 50);
  game.destroy();
});
