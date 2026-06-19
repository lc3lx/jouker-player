const test = require("node:test");
const assert = require("node:assert/strict");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
const rules = require("../games/tarneeb41/tarneeb41.rules");
const { findAvailableTarneeb41Table } = require("../services/tableService");

function mkFourHumans() {
  const game = new Tarneeb41Game("seat_test", { mongoTableId: "seat_test" });
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
  return game;
}

function relativeSeat(mySeat, absolute) {
  return (absolute - mySeat + 4) % 4;
}

test("seating rotation — partner always offset 2", () => {
  for (let mySeat = 0; mySeat < 4; mySeat += 1) {
    const partnerAbs = (mySeat + 2) % 4;
    assert.equal(relativeSeat(mySeat, partnerAbs), 2);
    assert.equal(relativeSeat(mySeat, mySeat), 0);
    assert.equal(relativeSeat(mySeat, (mySeat + 1) % 4), 1);
    assert.equal(relativeSeat(mySeat, (mySeat + 3) % 4), 3);
  }
});

test("100 players → 25 tables of 4 (allocation simulation)", () => {
  const tables = [];
  const allocate = () => {
    let table = tables.find((t) => t.length < 4);
    if (!table) {
      table = [];
      tables.push(table);
    }
    table.push(tables.reduce((n, t) => n + t.length, 0) + 1);
  };
  for (let i = 0; i < 100; i += 1) allocate();
  assert.equal(tables.length, 25);
  assert.ok(tables.every((t) => t.length === 4));
});

test("countdown starts only with four humans", () => {
  const game = mkFourHumans();
  try {
    assert.equal(game.isReadyForCountdown(), true);
    assert.equal(game.startGameCountdown(), true);
    assert.equal(game.state, "countdown");
    assert.equal(game.countdownSeconds, 15);
  } finally {
    game.destroy();
  }
});

test("countdown cancellation returns to waiting", () => {
  const game = mkFourHumans();
  try {
    game.startGameCountdown();
    assert.equal(game.cancelGameCountdown("player_left"), true);
    assert.equal(game.state, "waiting");
    assert.equal(game.countdownInterval, null);
  } finally {
    game.destroy();
  }
});

test("countdown completion deals and enters bidding", () => {
  const game = mkFourHumans();
  try {
    game.clearBotTimer();
    game.clearCountdown();
    assert.equal(game.startGame(), true);
    assert.equal(game.state, "bidding_syrian");
    assert.ok(game.hands[0].length === 13);
  } finally {
    game.destroy();
  }
});

test("win condition requires team >= 41 and opponent team > 0", () => {
  assert.equal(rules.checkGameEnd([41, 10, 5, 8]).ended, true);
  assert.equal(rules.checkGameEnd([41, 0, 0, 0]).ended, false);
  assert.equal(rules.checkGameEnd([40, 10, 5, 8]).ended, false);
  assert.equal(rules.checkGameEnd([10, 41, 8, 5]).ended, true);
  assert.equal(rules.checkGameEnd([0, 41, 0, 0]).ended, false);
});

test("last trick stays visible until finalize", () => {
  const game = mkFourHumans();
  try {
    game.clearBotTimer();
    game.state = "playing";
    game.hands = [[], [], [], []];
    game.trick = [
      { playerIndex: 0, card: { suit: "hearts", rank: 10 } },
      { playerIndex: 1, card: { suit: "hearts", rank: 11 } },
      { playerIndex: 2, card: { suit: "hearts", rank: 12 } },
      { playerIndex: 3, card: { suit: "hearts", rank: 14 } },
    ];
    game.trickResolving = true;
    game.pendingTrickWinner = 3;
    game.ledSuit = "hearts";
    assert.equal(game.trick.length, 4);
    assert.equal(game.tricksThisRound[3], 0);
    game.finalizePendingTrickNow();
    assert.equal(game.trick.length, 0);
    assert.equal(game.tricksThisRound[3], 1);
    assert.equal(game.trickResolving, false);
  } finally {
    game.destroy();
  }
});

test("play blocked while trick resolving", () => {
  const game = mkFourHumans();
  try {
    game.state = "playing";
    game.trickResolving = true;
    game.currentPlayerIndex = 0;
    game.hands[0] = [{ suit: "hearts", rank: 10 }];
    const result = game.applyMove(0, "play_card", {
      card: { suit: "Hearts", rank: "10" },
      moveId: "blocked",
    });
    assert.equal(result.success, false);
    assert.equal(result.reason, "trick_resolving");
  } finally {
    game.destroy();
  }
});

test("reconnect during countdown preserves countdown state", () => {
  const game = mkFourHumans();
  try {
    game.startGameCountdown();
    const before = game.countdownSeconds;
    game.syncLobbyFromTable(
      {
        seats: game.players.map((p, i) => ({
          user: { _id: p.userId, name: p.displayName },
          chips: 1000,
        })),
      },
      (uid) => `sock_${uid}`
    );
    assert.equal(game.state, "countdown");
    assert.equal(game.countdownSeconds, before);
  } finally {
    game.destroy();
  }
});

test("findAvailableTarneeb41Table is exported", () => {
  assert.equal(typeof findAvailableTarneeb41Table, "function");
});
