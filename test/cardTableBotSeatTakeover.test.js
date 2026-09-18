/**
 * Sitting in a bot's seat — Trix and Tarneeb 41, against the real engines.
 *
 * Poker lets a joining player take over a bot's chair mid-hand. The same has to
 * hold at the card tables, and `test/trixBotSeat.test.js` /
 * `test/tarneeb41BotSeat.test.js` only exercise hand-written stubs of
 * `replaceBotWithHuman` — they would keep passing if the real engine method
 * stopped working. These drive the shipped classes.
 *
 * No Mongo: the wallet half of the claim is covered by the service tests. What
 * is verified here is the engine half — the seat actually changes hands, the
 * hand in flight survives it, and a seat that is not a bot is refused.
 */
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const TrixGame = require("../games/trix/TrixGame");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
// Tarneeb41Game has no listReplaceableBotSeats of its own — the service scans
// the roster for it, which is the path the join route actually takes.
const {
  listReplaceableBotSeats: tarneebBotSeats,
} = require("../services/tarneeb41BotSeatService");

function seatHuman(game, seatIndex, userId) {
  game.players.push({
    userId,
    socketId: `s_${userId}`,
    seatIndex,
    isBot: false,
    displayName: `P${seatIndex}`,
    chips: 10000,
  });
}

/** A live Trix game: one human and three bots, cards dealt. */
async function liveTrixGame() {
  const game = new TrixGame("trix_takeover_test", { mongoTableId: "t1" });
  seatHuman(game, 0, "u0");
  await game.startGame();
  game.clearBotTimer(); // no background play while we poke at seats
  game.clearTurnTimer();
  return game;
}

/**
 * A live Tarneeb 41 game: one human and three bots, cards dealt.
 *
 * Unlike Trix, `startGame` here refuses anything but a full roster — bots are
 * seated by `fillWithBots`, which is the path the table takes when a waiting
 * room times out.
 */
async function liveTarneebGame() {
  const game = new Tarneeb41Game("t41_takeover_test", { mongoTableId: "t1" });
  seatHuman(game, 0, "u0");
  const started = await game.fillWithBots();
  assert.equal(started, true, "the table has to be live for a takeover to mean anything");
  game.clearBotTimer?.();
  game.clearTurnTimer?.();
  return game;
}

test("Trix: an engine filled with bots reports their seats as claimable", async () => {
  const game = await liveTrixGame();
  try {
    const seats = game.listReplaceableBotSeats();
    assert.deepEqual(seats.map((s) => s.seatIndex).sort(), [1, 2, 3]);
    assert.equal(game.players.filter((p) => p.isBot).length, 3);
  } finally {
    game.destroy();
  }
});

test("Trix: a human takes a bot's seat and the seat really changes hands", async () => {
  const game = await liveTrixGame();
  try {
    const ok = await game.replaceBotWithHuman(2, "u_new", "sock_new", "وافد");
    assert.equal(ok, true);

    const seat = game.players.find((p) => p.seatIndex === 2);
    assert.equal(seat.isBot, false, "the lobby seat is now a human");
    assert.equal(String(seat.userId), "u_new");
    assert.equal(seat.displayName, "وافد");

    // The engine's parallel roster has to follow, or the bot loop keeps
    // playing that seat's cards for them.
    assert.equal(game.gameState.players[2].isBot, false);
    assert.equal(game.gameState.players[2].name, "وافد");
    assert.equal(game.listReplaceableBotSeats().length, 2);
  } finally {
    game.destroy();
  }
});

test("Trix: the hand in flight survives the takeover", async () => {
  const game = await liveTrixGame();
  try {
    const before = game.gameState.players[2].hand.length;
    const king = game.gameState.currentKingIndex;

    await game.replaceBotWithHuman(2, "u_new", "sock_new", "وافد");

    assert.equal(
      game.gameState.players[2].hand.length,
      before,
      "the cards belong to the seat, not to the bot",
    );
    assert.equal(game.gameState.currentKingIndex, king, "the deal is untouched");
    assert.equal(game.state, "selecting_game");
  } finally {
    game.destroy();
  }
});

test("Trix: a seat that is not a bot cannot be taken", async () => {
  const game = await liveTrixGame();
  try {
    // Seat 0 is the human who opened the table.
    assert.equal(await game.replaceBotWithHuman(0, "u_new", null, "وافد"), false);
    assert.equal(await game.replaceBotWithHuman(9, "u_new", null, "وافد"), false);
    assert.equal(String(game.players.find((p) => p.seatIndex === 0).userId), "u0");
  } finally {
    game.destroy();
  }
});

test("Trix: a vacated seat is held for its owner unless takeover is allowed", async () => {
  const game = await liveTrixGame();
  try {
    const held = game.players.find((p) => p.seatIndex === 3);
    held.vacatedFromUserId = "u_left";

    assert.equal(
      await game.replaceBotWithHuman(3, "someone_else", null, "دخيل"),
      false,
      "the grace window belongs to the player who left",
    );
    assert.equal(
      await game.replaceBotWithHuman(3, "u_left", null, "عائد"),
      true,
      "and they can walk straight back into it",
    );
    assert.equal(game.players.find((p) => p.seatIndex === 3).isBot, false);
  } finally {
    game.destroy();
  }
});

test("Trix: an expired grace window lets anyone in via allowTakeover", async () => {
  const game = await liveTrixGame();
  try {
    game.players.find((p) => p.seatIndex === 1).vacatedFromUserId = "u_left";
    const ok = await game.replaceBotWithHuman(1, "u_new", null, "وافد", {
      allowTakeover: true,
    });
    assert.equal(ok, true);
    const seat = game.players.find((p) => p.seatIndex === 1);
    assert.equal(seat.isBot, false);
    assert.equal(seat.vacatedFromUserId, undefined, "the claim is cleared with the seat");
  } finally {
    game.destroy();
  }
});

test("Tarneeb 41: a human takes a bot's seat mid-hand", async () => {
  const game = await liveTarneebGame();
  try {
    const seats = tarneebBotSeats(game);
    assert.ok(seats.length >= 1, "the table filled with bots");

    const target = seats[0].seatIndex;
    const before = game.hands[target].length;

    const ok = await game.replaceBotWithHuman(target, "u_new", "sock_new", "وافد");
    assert.equal(ok, true);

    const seat = game.players.find((p) => p.seatIndex === target);
    assert.equal(seat.isBot, false);
    assert.equal(String(seat.userId), "u_new");
    assert.equal(
      game.hands[target].length,
      before,
      "the thirteen cards stay with the chair",
    );
  } finally {
    game.destroy();
  }
});

test("Tarneeb 41: the declared bid stays with the seat, not the bot", async () => {
  const game = await liveTarneebGame();
  try {
    const target = tarneebBotSeats(game)[0].seatIndex;
    game.declaredBids[target] = 4;
    game.tricksThisRound[target] = 1;

    await game.replaceBotWithHuman(target, "u_new", "sock_new", "وافد");

    assert.equal(game.declaredBids[target], 4, "the new player inherits the bid");
    assert.equal(game.tricksThisRound[target], 1, "and the tricks already taken");
  } finally {
    game.destroy();
  }
});

test("Tarneeb 41: a human seat is never handed to a joiner", async () => {
  const game = await liveTarneebGame();
  try {
    assert.equal(await game.replaceBotWithHuman(0, "u_new", null, "وافد"), false);
    assert.equal(String(game.players.find((p) => p.seatIndex === 0).userId), "u0");
  } finally {
    game.destroy();
  }
});
