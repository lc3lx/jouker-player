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

/**
 * Run `fn` against a fresh game and tear it down afterwards.
 *
 * **Await this.** It used to be sync-`finally`, which destroyed the game the
 * moment an async body first suspended — so every assertion after an `await`
 * ran against a destroyed game, after the test had already been reported as
 * passing, and a failure surfaced only as an unhandledRejection warning.
 */
async function withGame(fn) {
  const game = mkGame();
  try {
    return await fn(game);
  } finally {
    game.destroy();
  }
}

test("needsInitialDeal returns true only in waiting state", async () => {
  await withGame(async (game) => {
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

test("join guard — needsInitialDeal false after game started", async () => {
  await withGame(async (game) => {
    assert.equal(game.needsInitialDeal(), true);
    await game.startGame();
    assert.equal(game.needsInitialDeal(), false);
    assert.equal(game.state, "bidding_syrian");
    assert.ok(game.hands[0].length > 0);
  });
});

test("redeal when declared sum is below minimum", async () => {
  await withGame(async (game) => {
    await game.startGame();
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

test("move deduplication rejects duplicate moveId", async () => {
  await withGame(async (game) => {
    await game.startGame();
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

test("turn timeout auto-pass during bidding", async () => {
  await withGame(async (game) => {
    await game.startGame();
    game.clearTurnTimer();
    const idx = game.currentPlayerIndex;
    assert.equal(game.players[idx].isBot, false);
    game.handleTurnTimeout();
    assert.equal(game.declaredBids[idx], 0);
    assert.notEqual(game.currentPlayerIndex, idx);
  });
});

test("turn timeout auto-plays lowest valid card during playing", async () => {
  await withGame(async (game) => {
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

test("syncLobbyFromTable refreshes sockets without rebuilding roster in progress", async () => {
  await withGame(async (game) => {
    await game.startGame();
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

test("getGameState includes turnTimer when active", async () => {
  await withGame(async (game) => {
    game.turnTimerPhase = "bidding";
    game.turnTimerEndsAt = Date.now() + 25000;
    const state = game.getGameState(0);
    assert.equal(state.turnTimer.phase, "bidding");
    assert.equal(state.turnTimer.playerIndex, game.currentPlayerIndex);
    assert.ok(state.turnTimer.remainingSeconds > 0);
  });
});

test("turn timer events fire via setGameEventListener", async () => {
  await withGame(async (game) => {
    await game.startGame();
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

test("game_end clears bot and turn timers", async () => {
  await withGame(async (game) => {
    await game.startGame();
    game.playerScores = [41, 10, 5, 8];
    game.endRound();
    assert.equal(game.state, "game_end");
    assert.equal(game.botInterval, null);
    assert.equal(game.turnTimerPhase, null);
  });
});

// ── a scrapped deal is a *new* deal, and the table is told ───────────────────
//
// Reported as the table feeling frozen: the declarations all reset to dashes
// with no explanation. The redeal was happening — but the notice that says so
// never reached the player, so from the felt it looked like a hang.

const rules = require("../games/tarneeb41/tarneeb41.rules");

/** Everyone passes, which is a sum of 0 — always below the floor. */
function allPass(game) {
  let result;
  for (let i = 0; i < 4; i += 1) {
    result = game.applyMove(
      game.currentPlayerIndex,
      "tarneeb41_declare",
      { value: 0 }
    );
  }
  return result;
}

test("a redeal deals fresh cards and a fresh trump", async () => {
  await withGame(async (game) => {
    await game.startGame();
    game.currentPlayerIndex = 0;

    const firstCard = { ...game.revealedCard };
    const firstHand = game.hands[0].map((c) => `${c.rank}${c.suit}`).join(",");

    assert.equal(allPass(game).redeal, true);

    assert.equal(game.state, "bidding_syrian", "back to bidding");
    assert.deepEqual(
      game.declaredBids,
      [null, null, null, null],
      "the failed declarations are cleared",
    );
    assert.equal(game.hands[0].length, 13);
    assert.notEqual(
      game.hands[0].map((c) => `${c.rank}${c.suit}`).join(","),
      firstHand,
      "the hand is actually re-dealt, not kept",
    );

    // The trump is always derived from the new revealed card, so re-deriving it
    // from whatever was dealt is what "طرنيب جديد" has to mean.
    assert.ok(game.revealedCard, "a card is revealed for the new deal");
    assert.equal(
      game.trump,
      rules.oppositeColorSuit(game.revealedCard.suit),
      "the trump matches the card this deal revealed",
    );
    if (game.revealedCard.suit !== firstCard.suit) {
      assert.notEqual(
        game.trump,
        rules.oppositeColorSuit(firstCard.suit),
        "a different revealed suit means a different trump",
      );
    }
  });
});

test("the redeal is reported, so the table can say why it reset", async () => {
  await withGame(async (game) => {
    const seen = [];
    game.setAfterMoveListener((r) => seen.push(r));
    await game.startGame();
    game.currentPlayerIndex = 0;

    allPass(game);

    const redeal = seen.find((r) => r && r.redeal);
    assert.ok(redeal, "the move result carries the redeal flag");
    assert.equal(redeal.reason, "sum_below_min");
    assert.equal(redeal.minSum, rules.SUM_MIN_TO_PLAY);
  });
});

test("a sum that clears the floor plays, and never redeals", async () => {
  await withGame(async (game) => {
    await game.startGame();
    game.currentPlayerIndex = 0;

    let result;
    for (let i = 0; i < 4; i += 1) {
      result = game.applyMove(
        game.currentPlayerIndex,
        "tarneeb41_declare",
        { value: 3 }
      );
    }

    assert.equal(result.redeal, undefined);
    assert.equal(game.state, "playing");
    assert.ok(
      12 >= rules.SUM_MIN_TO_PLAY,
      "4x3 clears the floor, so the deal stands",
    );
  });
});

test("the bidding turn timer restarts on the new deal", async () => {
  await withGame(async (game) => {
    await game.startGame();
    game.currentPlayerIndex = 0;
    allPass(game);

    // Without this the table really would hang: nothing would ever time the
    // first declaration of the replacement deal out.
    assert.equal(game.turnTimerPhase, "bidding");
    assert.ok(
      game.turnTimerEndsAt && game.turnTimerEndsAt > Date.now(),
      "a live deadline is armed for the new deal",
    );
  });
});
