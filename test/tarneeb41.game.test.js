const test = require("node:test");
const assert = require("node:assert/strict");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");

function mkGame() {
  const game = new Tarneeb41Game("test_room", { mongoTableId: "t1" });
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

function withGame(fn) {
  const game = mkGame();
  try {
    return fn(game);
  } finally {
    game.destroy();
  }
}

test("needsInitialDeal returns true only in waiting state", () => {
  withGame((game) => {
    assert.equal(game.needsInitialDeal(), true);
    game.state = "bidding_syrian";
    assert.equal(game.needsInitialDeal(), false);
    game.state = "playing";
    assert.equal(game.needsInitialDeal(), false);
    game.state = "round_end";
    assert.equal(game.needsInitialDeal(), false);
    game.state = "game_end";
    assert.equal(game.needsInitialDeal(), false);
  });
});

test("join guard — needsInitialDeal false after game started", () => {
  withGame((game) => {
    assert.equal(game.needsInitialDeal(), true);
    game.startGame();
    assert.equal(game.needsInitialDeal(), false);
    assert.equal(game.state, "bidding_syrian");
    assert.ok(game.hands[0].length > 0);
  });
});

test("redeal when declared sum is below minimum", () => {
  withGame((game) => {
    game.startGame();
    game.currentPlayerIndex = 0;
    let result;
    for (let i = 0; i < 4; i += 1) {
      const idx = game.currentPlayerIndex;
      result = game.applyMove(idx, "tarneeb41_declare", { value: 0 });
      assert.equal(result.success, true);
    }
    assert.equal(result.redeal, true);
    assert.equal(game.state, "bidding_syrian");
    assert.ok(game.hands[0].length === 13);
  });
});

test("move deduplication rejects duplicate moveId", () => {
  withGame((game) => {
    game.startGame();
    const idx = game.currentPlayerIndex;
    const payload = { value: 5, moveId: "move-abc" };
    const first = game.applyMove(idx, "tarneeb41_declare", payload);
    assert.equal(first.success, true);
    assert.equal(first.duplicate, undefined);
    const dup = game.applyMove(idx, "tarneeb41_declare", payload);
    assert.equal(dup.success, true);
    assert.equal(dup.duplicate, true);
  });
});

test("turn timeout auto-pass during bidding", () => {
  withGame((game) => {
    game.startGame();
    game.clearTurnTimer();
    const idx = game.currentPlayerIndex;
    assert.equal(game.players[idx].isBot, false);
    game.handleTurnTimeout();
    assert.equal(game.declaredBids[idx], 0);
    assert.notEqual(game.currentPlayerIndex, idx);
  });
});

test("turn timeout auto-plays lowest valid card during playing", () => {
  withGame((game) => {
    game.state = "playing";
    game.currentPlayerIndex = 0;
    game.hands[0] = [
      { suit: "hearts", rank: 10 },
      { suit: "spades", rank: 5 },
      { suit: "clubs", rank: 14 },
    ];
    game.ledSuit = null;
    game.handleTurnTimeout();
    assert.equal(game.hands[0].length, 2);
    assert.equal(game.trick.length, 1);
    assert.equal(game.trick[0].card.rank, 5);
  });
});

test("syncLobbyFromTable refreshes sockets without rebuilding roster in progress", () => {
  withGame((game) => {
    game.startGame();
    const rosterBefore = game.players.map((p) => p.userId);
    game.syncLobbyFromTable(
      {
        seats: [
          { user: { _id: "other1", name: "X" }, chips: 100 },
          { user: { _id: "other2", name: "Y" }, chips: 100 },
        ],
      },
      (uid) => `sock_${uid}`
    );
    assert.deepEqual(
      game.players.map((p) => p.userId),
      rosterBefore
    );
    assert.equal(game.players[0].socketId, "sock_u0");
  });
});

test("getGameState includes turnTimer when active", () => {
  withGame((game) => {
    game.turnTimerPhase = "bidding";
    game.turnTimerEndsAt = Date.now() + 25000;
    const state = game.getGameState(0);
    assert.equal(state.turnTimer.phase, "bidding");
    assert.equal(state.turnTimer.playerIndex, game.currentPlayerIndex);
    assert.ok(state.turnTimer.remainingSeconds > 0);
  });
});

test("turn timer events fire via setGameEventListener", () => {
  withGame((game) => {
    game.startGame();
    game.clearTurnTimer();
    const events = [];
    game.setGameEventListener((event, payload) => {
      events.push({ event, payload });
    });
    game.startTurnTimer();
    assert.ok(events.some((e) => e.event === "turn_timer_started"));
    assert.equal(events.find((e) => e.event === "turn_timer_started").payload.phase, "bidding");
  });
});

test("game_end clears bot and turn timers", () => {
  withGame((game) => {
    game.startGame();
    game.playerScores = [41, 10, 5, 8];
    game.endRound();
    assert.equal(game.state, "game_end");
    assert.equal(game.botInterval, null);
    assert.equal(game.turnTimerPhase, null);
  });
});
