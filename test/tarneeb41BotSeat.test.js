const test = require("node:test");
const assert = require("node:assert/strict");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
const { listReplaceableBotSeats } = require("../services/tarneeb41BotSeatService");

test("replaceBotWithHuman allows takeover when allowTakeover is true", () => {
  const game = new Tarneeb41Game("r1", { mongoTableId: "t1" });
  game.state = "bidding_syrian";
  game.players.push({
    userId: "bot_vacate_1",
    socketId: null,
    seatIndex: 1,
    isBot: true,
    displayName: "بوت",
    chips: 1000,
    vacatedFromUserId: "u_original",
  });
  assert.equal(
    game.replaceBotWithHuman(1, "u_new", "sock", "New Player", {
      allowTakeover: true,
      chips: 1000,
    }),
    true
  );
  assert.equal(game.players[0].isBot, false);
  assert.equal(game.players[0].userId, "u_new");
  assert.equal(game.players[0].vacatedFromUserId, undefined);
  game.destroy();
});

test("replaceBotWithHuman blocks takeover for vacated seat without allowTakeover", () => {
  const game = new Tarneeb41Game("r1", { mongoTableId: "t1" });
  game.players.push({
    userId: "bot_vacate_1",
    socketId: null,
    seatIndex: 0,
    isBot: true,
    displayName: "بوت",
    vacatedFromUserId: "u_original",
  });
  assert.equal(game.replaceBotWithHuman(0, "u_other", "s", "X"), false);
  assert.equal(
    game.replaceBotWithHuman(0, "u_original", "s", "Original"),
    true
  );
  game.destroy();
});

test("listReplaceableBotSeats returns bot seat indices", () => {
  const game = new Tarneeb41Game("r1");
  game.players = [
    { seatIndex: 0, isBot: false, userId: "u0" },
    { seatIndex: 1, isBot: true, userId: "bot_1", vacatedFromUserId: "u1" },
    { seatIndex: 2, isBot: false, userId: "u2" },
    { seatIndex: 3, isBot: true, userId: "bot_3" },
  ];
  game.state = "playing";
  const seats = listReplaceableBotSeats(game);
  assert.equal(seats.length, 2);
  assert.deepEqual(
    seats.map((s) => s.seatIndex).sort(),
    [1, 3]
  );
  game.destroy();
});
