const test = require("node:test");
const assert = require("node:assert/strict");
const {
  listReplaceableBotSeats,
} = require("../services/trixBotSeatService");

test("Trix listReplaceableBotSeats returns bot seat indices", () => {
  const game = {
    players: [
      { seatIndex: 0, isBot: false, userId: "u0" },
      { seatIndex: 1, isBot: true, userId: "bot_1", vacatedFromUserId: "u1" },
      { seatIndex: 2, isBot: false, userId: "u2" },
      { seatIndex: 3, isBot: true, userId: "bot_3" },
    ],
  };
  const seats = listReplaceableBotSeats(game);
  assert.deepEqual(
    seats.map((s) => s.seatIndex).sort(),
    [1, 3]
  );
  assert.equal(seats.find((s) => s.seatIndex === 1)?.vacatedFromUserId, "u1");
});

test("Trix replaceBotWithHuman allows takeover when allowTakeover is true", async () => {
  const game = {
    state: "playing",
    players: [
      {
        seatIndex: 1,
        isBot: true,
        userId: "bot_1",
        vacatedFromUserId: "u_original",
        displayName: "Bot",
      },
    ],
    async replaceBotWithHuman(seatIndex, userId, socketId, displayName, opts = {}) {
      const p = this.players.find((x) => x.seatIndex === seatIndex);
      if (!p || !p.isBot) return false;
      if (
        !opts.allowTakeover &&
        p.vacatedFromUserId &&
        String(p.vacatedFromUserId) !== String(userId)
      ) {
        return false;
      }
      p.isBot = false;
      p.userId = userId;
      p.socketId = socketId;
      p.displayName = displayName;
      delete p.vacatedFromUserId;
      return true;
    },
  };

  assert.equal(
    await game.replaceBotWithHuman(1, "u_new", "sock", "New Player", {
      allowTakeover: true,
    }),
    true
  );
  assert.equal(game.players[0].isBot, false);
  assert.equal(game.players[0].userId, "u_new");
  assert.equal(game.players[0].vacatedFromUserId, undefined);
});
