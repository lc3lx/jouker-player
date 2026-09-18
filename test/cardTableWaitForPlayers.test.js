/**
 * A card table holds its empty seats open for real players before bots take
 * them — the same fifteen seconds poker already used.
 *
 * Before this, Trix dealt the moment the first player sat down: `startGame()`
 * filled every empty chair with a bot and dealt, so a player who opened a table
 * was in a hand against three bots before they could look up. `syncLobbyFromTable`
 * did the same thing a step earlier, seating the bots into the roster on join.
 *
 * Tarneeb did wait, but only because the *table screen* ran a 30s timer and
 * then emitted `fill_with_bots`. A client-side timer is not a rule: background
 * the app or drop the socket and nothing ever fills.
 *
 * The window is the server's now, and these pin it.
 */
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const TrixGame = require("../games/trix/TrixGame");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
const { WAIT_FOR_PLAYERS_MS } = require("../utils/cardTableTimings");

function seatHumans(game, count) {
  for (let i = 0; i < count; i += 1) {
    game.players.push({
      userId: `u${i}`,
      socketId: `s${i}`,
      seatIndex: i,
      isBot: false,
      displayName: `P${i}`,
      chips: 10000,
    });
  }
}

function botCount(game) {
  return game.players.filter((p) => p && p.isBot).length;
}

/** A table document the way the join path hands it over. */
function tableDoc({ humans = 1, botsEnabled = true } = {}) {
  return {
    seats: Array.from({ length: humans }, (_, i) => ({
      user: { _id: `u${i}`, name: `P${i}` },
      chips: 10000,
    })),
    settings: { botsEnabled },
  };
}

const noSocket = () => null;

test("the window is fifteen seconds", () => {
  assert.equal(WAIT_FOR_PLAYERS_MS, 15000);
});

// ── Trix ─────────────────────────────────────────────────────────────────────

test("Trix: one player does not get an instant deal", async () => {
  const game = new TrixGame("trix_wait_1", { mongoTableId: "t1" });
  try {
    await game.syncLobbyFromTable(tableDoc({ humans: 1 }), noSocket);
    const result = await game.startOrWaitForPlayers();

    assert.equal(result.waiting, true);
    assert.equal(result.started, false);
    assert.equal(game.gameState, null, "no cards are dealt while waiting");
    assert.equal(botCount(game), 0, "and no bots have sat down");
    assert.ok(result.remainingSeconds > 0 && result.remainingSeconds <= 15);
  } finally {
    game.destroy();
  }
});

test("Trix: the roster stays human-only while the window runs", async () => {
  const game = new TrixGame("trix_wait_2", { mongoTableId: "t1" });
  try {
    await game.syncLobbyFromTable(tableDoc({ humans: 1 }), noSocket);
    // This is where the bots used to appear, before startGame was even called.
    assert.equal(game.players.length, 1);
    assert.equal(botCount(game), 0);
  } finally {
    game.destroy();
  }
});

test("Trix: a full table of humans deals at once, with no wait", async () => {
  const game = new TrixGame("trix_wait_3", { mongoTableId: "t1" });
  try {
    await game.syncLobbyFromTable(tableDoc({ humans: 4 }), noSocket);
    const result = await game.startOrWaitForPlayers();

    assert.equal(result.waiting, false);
    assert.equal(result.started, true);
    assert.ok(game.gameState, "four humans need nobody to wait for");
    assert.equal(botCount(game), 0);
  } finally {
    game.destroy();
  }
});

test("Trix: when the window runs out the bots come down and the deal starts", async () => {
  const game = new TrixGame("trix_wait_4", { mongoTableId: "t1" });
  try {
    await game.syncLobbyFromTable(tableDoc({ humans: 1 }), noSocket);
    await game.startOrWaitForPlayers();
    assert.equal(game.gameState, null);

    await game._onWaitForPlayersElapsed();

    assert.ok(game.gameState, "the deal starts when the wait is over");
    assert.equal(game.players.length, 4);
    assert.equal(botCount(game), 3);
    game.clearBotTimer();
    game.clearTurnTimer();
  } finally {
    game.destroy();
  }
});

test("Trix: a second player joining does not restart the window", async () => {
  const game = new TrixGame("trix_wait_5", { mongoTableId: "t1" });
  try {
    await game.syncLobbyFromTable(tableDoc({ humans: 1 }), noSocket);
    const first = await game.startOrWaitForPlayers();
    const deadline = game.waitForPlayersUntil;

    await game.syncLobbyFromTable(tableDoc({ humans: 2 }), noSocket);
    const second = await game.startOrWaitForPlayers();

    assert.equal(second.waiting, true);
    assert.equal(
      game.waitForPlayersUntil,
      deadline,
      "the seat was opened once; joining does not buy everyone more time",
    );
    assert.ok(second.remainingSeconds <= first.remainingSeconds);
  } finally {
    game.destroy();
  }
});

test("Trix: an empty table does not arm a window at all", async () => {
  const game = new TrixGame("trix_wait_6", { mongoTableId: "t1" });
  try {
    await game.syncLobbyFromTable(tableDoc({ humans: 0 }), noSocket);
    const result = await game.startOrWaitForPlayers();

    assert.equal(result.waiting, false);
    assert.equal(game.waitForPlayersUntil, null, "nothing to hold a seat for");
    assert.equal(game.gameState, null);
  } finally {
    game.destroy();
  }
});

test("Trix: a humans-only table keeps waiting instead of seating bots", async () => {
  const game = new TrixGame("trix_wait_7", { mongoTableId: "t1" });
  try {
    await game.syncLobbyFromTable(
      tableDoc({ humans: 1, botsEnabled: false }),
      noSocket,
    );
    assert.equal(game.botsEnabled, false);
    await game.startOrWaitForPlayers();

    await game._onWaitForPlayersElapsed();

    assert.equal(botCount(game), 0, "no bot may sit at a humans-only table");
    assert.equal(game.gameState, null);
    assert.ok(
      game.waitForPlayersUntil != null,
      "the window re-arms rather than leaving a dead countdown behind",
    );
  } finally {
    game.destroy();
  }
});

test("Trix: a document with no settings leaves the bot policy alone", async () => {
  const game = new TrixGame("trix_wait_8", { mongoTableId: "t1" });
  try {
    game.botsEnabled = false;
    // The synthetic stand-in shape — `undefined !== false` reads as "allowed".
    await game.syncLobbyFromTable({ seats: [] }, noSocket);
    assert.equal(game.botsEnabled, false);
  } finally {
    game.destroy();
  }
});

test("Trix: the wait is reported while it runs and stops once dealt", async () => {
  const game = new TrixGame("trix_wait_9", { mongoTableId: "t1" });
  try {
    await game.syncLobbyFromTable(tableDoc({ humans: 1 }), noSocket);
    await game.startOrWaitForPlayers();
    assert.equal(game.isWaitingForPlayers(), true);
    assert.ok(game.remainingWaitSeconds() > 0);

    await game._onWaitForPlayersElapsed();
    assert.equal(game.isWaitingForPlayers(), false);
    assert.equal(game.remainingWaitSeconds(), 0);
    game.clearBotTimer();
    game.clearTurnTimer();
  } finally {
    game.destroy();
  }
});

// ── Tarneeb 41 ───────────────────────────────────────────────────────────────

test("Tarneeb: one player waits instead of getting bots", () => {
  const game = new Tarneeb41Game("t41_wait_1", { mongoTableId: "t1" });
  try {
    seatHumans(game, 1);
    const result = game.startOrWaitForPlayers();

    assert.equal(result.waiting, true);
    assert.equal(game.state, "waiting");
    assert.equal(botCount(game), 0);
    assert.ok(result.remainingSeconds > 0 && result.remainingSeconds <= 15);
  } finally {
    game.destroy();
  }
});

test("Tarneeb: four humans go straight to the start countdown", () => {
  const game = new Tarneeb41Game("t41_wait_2", { mongoTableId: "t1" });
  try {
    seatHumans(game, 4);
    const result = game.startOrWaitForPlayers();

    assert.equal(result.waiting, false);
    assert.equal(game.state, "countdown");
    assert.equal(game.waitForPlayersUntil, null);
  } finally {
    game.destroy();
  }
});

test("Tarneeb: when the window runs out the table fills and deals", async () => {
  const game = new Tarneeb41Game("t41_wait_3", { mongoTableId: "t1" });
  try {
    seatHumans(game, 1);
    game.startOrWaitForPlayers();
    assert.equal(game.state, "waiting");

    await game._onWaitForPlayersElapsed();

    assert.equal(game.players.length, 4);
    assert.equal(botCount(game), 3);
    assert.equal(game.state, "bidding_syrian", "the deal is live");
  } finally {
    game.destroy();
  }
});

test("Tarneeb: a humans-only table never fills", async () => {
  const game = new Tarneeb41Game("t41_wait_4", { mongoTableId: "t1" });
  try {
    seatHumans(game, 2);
    game.applyTablePolicy({ settings: { botsEnabled: false } });
    game.startOrWaitForPlayers();

    await game._onWaitForPlayersElapsed();

    assert.equal(botCount(game), 0);
    assert.equal(game.state, "waiting");
    assert.ok(game.waitForPlayersUntil != null, "it keeps waiting");
  } finally {
    game.destroy();
  }
});

test("Tarneeb: the state packet carries the remaining wait", () => {
  const game = new Tarneeb41Game("t41_wait_5", { mongoTableId: "t1" });
  try {
    seatHumans(game, 1);
    game.startOrWaitForPlayers();

    const state = game.getGameState(0);
    assert.ok(state.waitForPlayersSeconds > 0);
    assert.ok(state.waitForPlayersSeconds <= 15);
  } finally {
    game.destroy();
  }
});

test("Tarneeb: a manual fill still short-circuits the wait", async () => {
  const game = new Tarneeb41Game("t41_wait_6", { mongoTableId: "t1" });
  try {
    seatHumans(game, 1);
    game.startOrWaitForPlayers();
    assert.ok(game.waitForPlayersUntil != null);

    await game.fillWithBots();

    assert.equal(game.waitForPlayersUntil, null, "the window is stood down");
    assert.equal(botCount(game), 3);
    assert.equal(game.state, "bidding_syrian");
  } finally {
    game.destroy();
  }
});

test("Tarneeb: an empty table arms nothing", () => {
  const game = new Tarneeb41Game("t41_wait_7", { mongoTableId: "t1" });
  try {
    const result = game.startOrWaitForPlayers();
    assert.equal(result.waiting, false);
    assert.equal(game.waitForPlayersUntil, null);
  } finally {
    game.destroy();
  }
});
