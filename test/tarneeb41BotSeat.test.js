const test = require("node:test");
const assert = require("node:assert/strict");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
const { listReplaceableBotSeats } = require("../services/tarneeb41BotSeatService");

function stubCosmetics(game) {
  game.applyCosmeticsToPlayers = async () => {};
}

test("replaceBotWithHuman allows takeover when allowTakeover is true", async () => {
  const game = new Tarneeb41Game("r1", { mongoTableId: "t1" });
  stubCosmetics(game);
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
    await game.replaceBotWithHuman(1, "u_new", "sock", "New Player", {
      allowTakeover: true,
      chips: 1000,
    }),
    true
  );
  assert.equal(game.players[0].isBot, false);
  assert.equal(String(game.players[0].userId), "u_new");
  assert.equal(game.players[0].vacatedFromUserId, undefined);
  game.destroy();
});

test("replaceBotWithHuman blocks takeover for vacated seat without allowTakeover", async () => {
  const game = new Tarneeb41Game("r1", { mongoTableId: "t1" });
  stubCosmetics(game);
  game.players.push({
    userId: "bot_vacate_1",
    socketId: null,
    seatIndex: 0,
    isBot: true,
    displayName: "بوت",
    vacatedFromUserId: "u_original",
  });
  assert.equal(await game.replaceBotWithHuman(0, "u_other", "s", "X"), false);
  assert.equal(
    await game.replaceBotWithHuman(0, "u_original", "s", "Original"),
    true
  );
  game.destroy();
});

test("native bot seat can be taken over mid-hand", async () => {
  const game = new Tarneeb41Game("r1", { mongoTableId: "t1" });
  stubCosmetics(game);
  game.state = "playing";
  game.players = [
    { seatIndex: 0, isBot: false, userId: "u0", displayName: "Host" },
    { seatIndex: 1, isBot: true, userId: "bot_1", displayName: "بوت" },
    { seatIndex: 2, isBot: true, userId: "bot_2", displayName: "بوت" },
    { seatIndex: 3, isBot: true, userId: "bot_3", displayName: "بوت" },
  ];
  const seats = listReplaceableBotSeats(game);
  assert.equal(seats.length, 3);
  assert.equal(
    await game.replaceBotWithHuman(seats[0].seatIndex, "u_joiner", "s1", "Joiner", {
      allowTakeover: true,
      chips: 500,
    }),
    true
  );
  assert.equal(game.humanCount(), 2);
  assert.equal(String(game.players.find((p) => p.seatIndex === 1).userId), "u_joiner");
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
