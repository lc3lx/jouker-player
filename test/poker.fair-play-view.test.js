const test = require("node:test");
const assert = require("node:assert/strict");

const { buildFairPlayView } = require("../services/fairPlayService");

test("buildFairPlayView numbers seats, marks winner, keeps board cards", () => {
  const view = buildFairPlayView(
    {
      handId: "h1",
      pot: 9000,
      handCategory: "full_house",
      community: ["As", "Kh", "Td", "2c", "2h"],
      winners: [{ user: "u1", share: 8000 }],
      seats: [
        {
          user: { _id: "u1", name: "أحمد" },
          name: "أحمد",
          isBot: false,
          hole: ["Ah", "Ad"],
          folded: false,
          won: true,
          net: 8000,
          handCategory: "full_house",
        },
        {
          isBot: true,
          name: "Bot Rex",
          hole: ["Qc", "Jd"],
          folded: false,
          won: false,
          net: -4000,
        },
        {
          user: "u2",
          name: "سامي",
          hole: ["7s", "8s"],
          folded: true,
          won: false,
          net: -1000,
        },
      ],
    },
    "u1"
  );

  assert.equal(view.community.length, 5);
  assert.equal(view.players.length, 3);
  assert.equal(view.players[0].number, 1);
  assert.equal(view.players[0].isMe, true);
  assert.equal(view.players[0].won, true);
  assert.deepEqual(view.players[0].hole, ["Ah", "Ad"]);
  assert.equal(view.players[1].isBot, true);
  assert.equal(view.players[2].folded, true);
  assert.equal(view.winners.length, 1);
  assert.equal(view.winners[0].name, "أحمد");
  assert.equal(view.winners[0].share, 8000);
  assert.equal(view.handId, "h1");
});

test("buildFairPlayView labels unnamed bot seats", () => {
  const view = buildFairPlayView(
    {
      pot: 100,
      community: ["As"],
      seats: [{ hole: ["Kd", "Kc"], chipsBefore: 100, chipsAfter: 0 }],
    },
    "nobody"
  );
  assert.equal(view.players[0].isBot, true);
  assert.match(view.players[0].name, /بوت/);
});

test("fair-play list numbering counts newest as the highest hand number", () => {
  const total = 10;
  const skip = 0;
  const docs = [
    { handId: "t-10" },
    { handId: "t-9" },
    { handId: "t-1" },
  ];
  const numbers = docs.map((_, i) => total - skip - i);
  assert.deepEqual(numbers, [10, 9, 8]);
});
