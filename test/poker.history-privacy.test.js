const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  participantFilter,
  redactHistoryForPlayer,
} = require("../services/handHistoryService");

test("player history keeps only the caller's hole cards and hides the seed", () => {
  const hand = {
    handId: "h-private",
    provablyFair: { serverSeed: "secret", serverSeedHash: "hash" },
    seats: [
      { user: "u1", hole: ["Ah", "Ad"] },
      { user: "u2", hole: ["Ks", "Kd"] },
    ],
  };

  const view = redactHistoryForPlayer(hand, "u1");
  assert.deepEqual(view.seats[0].hole, ["Ah", "Ad"]);
  assert.equal(Object.hasOwn(view.seats[1], "hole"), false);
  assert.equal(Object.hasOwn(view.provablyFair, "serverSeed"), false);
  assert.equal(view.provablyFair.serverSeedHash, "hash");
});

test("normal-user history queries are constrained to hand participants", () => {
  assert.deepEqual(participantFilter("u1"), { "players.user": "u1" });
});
