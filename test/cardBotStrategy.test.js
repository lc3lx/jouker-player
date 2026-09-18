/**
 * Trix and Tarneeb 41 bots must play the game, not dump cards.
 *
 * Both used to pick the lowest legal card in every situation and, in Trix, the
 * first available contract in every kingdom. These assert the plays that
 * separate a player from a card dumper — each one is a line the old bots got
 * wrong.
 *
 * Every case pins the decision with no personality/skill opts, so the ranking
 * itself is under test and no random misplay gate can flip a result.
 */
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const TrixBot = require("../engine/bots/TrixBot");
const TarneebBot = require("../engine/bots/TarneebBot");
const trixRules = require("../games/tarneeb41/tarneeb41.rules");

// ── Trix helpers ─────────────────────────────────────────────────────────────

function value(rank) {
  const n = parseInt(rank, 10);
  if (!Number.isNaN(n)) return n;
  return { J: 11, Q: 12, K: 13, A: 14 }[rank];
}

/** "AHearts" style shorthand → a Trix card. */
function c(rank, suit) {
  return { rank: String(rank), suit, value: value(String(rank)) };
}

function trixState({
  contract,
  hand,
  table = [],
  played = [],
  seat = 0,
  trixTable = null,
}) {
  const players = [0, 1, 2, 3].map((i) => ({ hand: i === seat ? hand : [], takenCards: [] }));
  return {
    currentGameType: contract,
    players,
    tableCards: table,
    leadingSuit: table.length > 0 ? table[0].card.suit : null,
    roundPlayedCards: played,
    finishedPlayers: [],
    trixTable: trixTable || {
      Spades: { min: null, max: null },
      Hearts: { min: null, max: null },
      Diamonds: { min: null, max: null },
      Clubs: { min: null, max: null },
    },
  };
}

function trixPick(state, seat, valid) {
  return TrixBot.botChooseCard(state, seat, valid);
}

// ── Trix: the penalty contracts ──────────────────────────────────────────────

test("K♥ goes overboard the moment the bot is void in the led suit", () => {
  const hand = [c("K", "Hearts"), c(2, "Clubs"), c(9, "Clubs")];
  const state = trixState({
    contract: "KingOfHearts",
    hand,
    seat: 0,
    table: [{ playerIndex: 1, card: c(7, "Spades") }],
  });

  // Void in spades → anything is legal, and only one card matters.
  const pick = trixPick(state, 0, hand);
  assert.equal(pick.rank, "K");
  assert.equal(pick.suit, "Hearts");
});

test("the bot never leads K♥ — that is simply handing over 75", () => {
  const hand = [c("K", "Hearts"), c(3, "Hearts"), c(8, "Clubs")];
  const state = trixState({ contract: "KingOfHearts", hand, seat: 0 });
  const pick = trixPick(state, 0, hand);
  assert.ok(
    !(pick.rank === "K" && pick.suit === "Hearts"),
    "leading the king loses the contract outright",
  );
});

test("K♥ is dumped under an ace that already took the trick", () => {
  // Hearts led, the ace is down, so the king can no longer win: shed it now.
  const hand = [c("K", "Hearts"), c(4, "Hearts"), c(6, "Hearts")];
  const state = trixState({
    contract: "KingOfHearts",
    hand,
    seat: 0,
    table: [
      { playerIndex: 1, card: c(2, "Hearts") },
      { playerIndex: 2, card: c("A", "Hearts") },
    ],
  });

  const pick = trixPick(state, 0, hand);
  assert.equal(pick.rank, "K", "the king is safe under the ace and must go");
});

test("holding the king under a low trick, the bot ducks instead", () => {
  const hand = [c("K", "Hearts"), c(4, "Hearts"), c(6, "Hearts")];
  const state = trixState({
    contract: "KingOfHearts",
    hand,
    seat: 0,
    table: [{ playerIndex: 1, card: c(2, "Hearts") }],
  });

  const pick = trixPick(state, 0, hand);
  assert.notEqual(pick.rank, "K", "playing the king here wins the trick with it");
});

test("ducking goes as high as is still safe, not as low as possible", () => {
  // A ten is down. The nine cannot win, so it is the right duck: it clears a
  // big card while the two stays behind as a later escape.
  const hand = [c(2, "Spades"), c(5, "Spades"), c(9, "Spades")];
  const state = trixState({
    contract: "Tricks",
    hand,
    seat: 0,
    table: [
      { playerIndex: 1, card: c(10, "Spades") },
      { playerIndex: 2, card: c(3, "Spades") },
      { playerIndex: 3, card: c(4, "Spades") },
    ],
  });

  const pick = trixPick(state, 0, hand);
  assert.equal(pick.rank, "9", "the old bot played the 2 and kept the 9 to get stuck with");
});

test("when void in a Queens contract the queen is the card that leaves", () => {
  const hand = [c("Q", "Spades"), c(3, "Clubs"), c("A", "Clubs")];
  const state = trixState({
    contract: "Queens",
    hand,
    seat: 0,
    table: [{ playerIndex: 1, card: c(5, "Diamonds") }],
  });

  const pick = trixPick(state, 0, hand);
  assert.equal(pick.rank, "Q");
});

test("a diamond discard sheds the biggest diamond, not the smallest", () => {
  const hand = [c(2, "Diamonds"), c("A", "Diamonds"), c(7, "Clubs")];
  const state = trixState({
    contract: "Diamonds",
    hand,
    seat: 0,
    table: [{ playerIndex: 1, card: c(5, "Spades") }],
  });

  const pick = trixPick(state, 0, hand);
  assert.equal(pick.rank, "A", "the ace of diamonds is the card that takes 10s later");
});

test("forced to take a trick, the bot takes it with its biggest card", () => {
  // Last to play, every card wins: the trick is lost either way, so the ace
  // goes now rather than stranding the hand with it.
  const hand = [c("A", "Clubs"), c("K", "Clubs")];
  const state = trixState({
    contract: "Tricks",
    hand,
    seat: 0,
    table: [
      { playerIndex: 1, card: c(2, "Clubs") },
      { playerIndex: 2, card: c(3, "Clubs") },
      { playerIndex: 3, card: c(4, "Clubs") },
    ],
  });

  const pick = trixPick(state, 0, hand);
  assert.equal(pick.rank, "A");
});

// ── Trix: the ladder ─────────────────────────────────────────────────────────

test("the jack opened is the one with the bot's own chain behind it", () => {
  // Clubs: J with 10-9-8 under it. Spades: a lone jack that only helps others.
  const hand = [
    c("J", "Clubs"), c(10, "Clubs"), c(9, "Clubs"), c(8, "Clubs"),
    c("J", "Spades"),
  ];
  const state = trixState({ contract: "Trix", hand, seat: 0 });
  const pick = trixPick(state, 0, [c("J", "Clubs"), c("J", "Spades")]);
  assert.equal(pick.suit, "Clubs");
});

test("on an open suit the bot plays the card that unlocks its own run", () => {
  // Hearts sit at 11..11. The 12 continues into my Q-K-A; the 10 into nothing.
  const hand = [c(10, "Hearts"), c("Q", "Hearts"), c("K", "Hearts"), c("A", "Hearts")];
  const state = trixState({
    contract: "Trix",
    hand,
    seat: 0,
    trixTable: {
      Spades: { min: null, max: null },
      Hearts: { min: 11, max: 11 },
      Diamonds: { min: null, max: null },
      Clubs: { min: null, max: null },
    },
  });

  const pick = trixPick(state, 0, [c(10, "Hearts"), c("Q", "Hearts")]);
  assert.equal(pick.rank, "Q", "the queen releases three more cards; the ten releases none");
});

// ── Trix: choosing the contract as king ──────────────────────────────────────

test("the king does not simply call the first contract on the list", () => {
  // A hand with four queens: Queens is the one contract to avoid.
  const hand = [
    c("Q", "Spades"), c("Q", "Hearts"), c("Q", "Diamonds"), c("Q", "Clubs"),
    c(2, "Spades"), c(3, "Spades"),
  ];
  const state = trixState({ contract: null, hand, seat: 0 });
  const pick = TrixBot.botChooseGame(state, 0, ["Queens", "Diamonds", "Tricks"]);
  assert.notEqual(pick, "Queens");
});

test("a hand with no K♥ prefers the King of Hearts contract", () => {
  const hand = [
    c(2, "Spades"), c(3, "Spades"), c(4, "Spades"),
    c("A", "Diamonds"), c("K", "Diamonds"), c("Q", "Diamonds"),
    c("Q", "Clubs"),
  ];
  const state = trixState({ contract: null, hand, seat: 0 });
  const pick = TrixBot.botChooseGame(state, 0, [
    "KingOfHearts", "Queens", "Diamonds", "Tricks",
  ]);
  assert.equal(pick, "KingOfHearts", "the risk belongs entirely to someone else");
});

test("a jack-rich hand calls Trix", () => {
  const hand = [
    c("J", "Spades"), c(10, "Spades"), c("Q", "Spades"),
    c("J", "Hearts"), c(10, "Hearts"), c("Q", "Hearts"),
    c("J", "Clubs"), c(10, "Clubs"),
  ];
  const state = trixState({ contract: null, hand, seat: 0 });
  const pick = TrixBot.botChooseGame(state, 0, ["Trix", "Tricks", "Diamonds"]);
  assert.equal(pick, "Trix");
});

test("choosing is deterministic and always returns a legal contract", () => {
  const hand = [c(5, "Spades"), c(6, "Hearts"), c(7, "Clubs")];
  const state = trixState({ contract: null, hand, seat: 0 });
  const available = ["Tricks", "Diamonds"];
  const first = TrixBot.botChooseGame(state, 0, available);
  assert.ok(available.includes(first));
  assert.equal(TrixBot.botChooseGame(state, 0, available), first);
});

// ── Tarneeb 41 ───────────────────────────────────────────────────────────────

function t(rank, suit) {
  return { rank, suit };
}

function tarneebCtx(over = {}) {
  return {
    seat: 0,
    trick: [],
    trump: "spades",
    declaredBids: [3, 3, 3, 3],
    tricksTaken: [0, 0, 0, 0],
    playedCards: [],
    ...over,
  };
}

function tarneebPick(hand, ledSuit, ctx) {
  return TarneebBot.pickAutoPlayCard(hand, ledSuit, trixRules, null, ctx);
}

test("a bot still short of its bid takes the trick rather than ducking", () => {
  const hand = [t(3, "hearts"), t(14, "hearts")];
  const pick = tarneebPick(hand, "hearts", tarneebCtx({
    trick: [{ card: t(9, "hearts"), playerIndex: 1 }],
    tricksTaken: [0, 0, 0, 0],
  }));
  assert.equal(pick.rank, 14, "the old bot played the 3 and lost a trick it needed");
});

test("it wins as cheaply as it can", () => {
  const hand = [t(10, "hearts"), t(14, "hearts")];
  const pick = tarneebPick(hand, "hearts", tarneebCtx({
    trick: [
      { card: t(9, "hearts"), playerIndex: 1 },
      { card: t(2, "hearts"), playerIndex: 2 },
      { card: t(5, "hearts"), playerIndex: 3 },
    ],
  }));
  assert.equal(pick.rank, 10, "the ten already takes it; the ace is worth keeping");
});

test("with its bid made it lets its partner keep the trick", () => {
  // Seat 2 is my partner and is winning; it still needs tricks.
  const hand = [t(4, "hearts"), t(14, "hearts")];
  const pick = tarneebPick(hand, "hearts", tarneebCtx({
    trick: [
      { card: t(3, "hearts"), playerIndex: 1 },
      { card: t(13, "hearts"), playerIndex: 2 },
    ],
    declaredBids: [2, 3, 4, 3],
    tricksTaken: [2, 0, 1, 0],
  }));
  assert.equal(pick.rank, 4, "overtaking my own partner costs us the trick");
});

test("with its bid made it still takes a trick that busts an opponent", () => {
  // Seat 1 is an opponent, is winning, and is one trick short of its bid.
  const hand = [t(4, "hearts"), t(14, "hearts")];
  const pick = tarneebPick(hand, "hearts", tarneebCtx({
    trick: [
      { card: t(13, "hearts"), playerIndex: 1 },
      { card: t(2, "hearts"), playerIndex: 2 },
      { card: t(5, "hearts"), playerIndex: 3 },
    ],
    declaredBids: [2, 3, 3, 3],
    tricksTaken: [2, 2, 0, 0],
  }));
  assert.equal(pick.rank, 14, "breaking their bid hands my team half of it each");
});

test("it does not burn a trump on a trick it is dodging", () => {
  // Bid made, nobody to bust; void in hearts so trumps are legal.
  const hand = [t(2, "spades"), t(9, "clubs"), t(3, "clubs")];
  const pick = tarneebPick(hand, "hearts", tarneebCtx({
    trick: [{ card: t(13, "hearts"), playerIndex: 1 }],
    declaredBids: [2, 0, 0, 0],
    tricksTaken: [2, 0, 0, 0],
  }));
  assert.notEqual(pick.suit, "spades", "the trump keeps its value for a trick I want");
});

test("it ruffs when it still needs the trick and cannot follow", () => {
  const hand = [t(2, "spades"), t(9, "clubs")];
  const pick = tarneebPick(hand, "hearts", tarneebCtx({
    trick: [{ card: t(13, "hearts"), playerIndex: 1 }],
    declaredBids: [4, 0, 0, 0],
    tricksTaken: [0, 0, 0, 0],
  }));
  assert.equal(pick.suit, "spades", "the only way to take this trick is to trump it");
});

test("the bid counts winners, not every face card", () => {
  // A-K-Q in one suit is not three tricks.
  const stacked = [
    t(14, "hearts"), t(13, "hearts"), t(12, "hearts"),
    t(2, "clubs"), t(3, "clubs"), t(4, "clubs"),
  ];
  const bid = TarneebBot.botBid(stacked, "spades");
  assert.ok(bid <= 3, `expected a sober bid, got ${bid}`);
  assert.ok(bid >= 2, "but it is still a bid, not a pass");
});

test("a hand with nothing passes", () => {
  const junk = [
    t(2, "hearts"), t(3, "hearts"), t(4, "clubs"),
    t(5, "clubs"), t(6, "diamonds"),
  ];
  assert.equal(TarneebBot.botBid(junk, "spades"), 0);
});

test("the last bidder stretches to save a deal from a redeal", () => {
  // Three seats have declared 3+3+2 = 8; the floor is 11. A seat that would
  // have bid 2 reaches higher rather than throwing the deal away.
  const hand = [
    t(14, "hearts"), t(4, "hearts"), t(5, "clubs"), t(6, "clubs"),
  ];
  const alone = TarneebBot.botBid(hand, "spades");
  const lastToBid = TarneebBot.botBid(hand, "spades", null, {
    seat: 3,
    declaredBids: [3, 3, 2, null],
  });
  assert.ok(lastToBid > alone, "the table needs two more tricks declared");
  assert.ok(lastToBid <= alone + 2, "but it never stretches past two");
});

test("it does not stretch when the table is already over the floor", () => {
  const hand = [t(14, "hearts"), t(4, "hearts"), t(5, "clubs")];
  const alone = TarneebBot.botBid(hand, "spades");
  const withSum = TarneebBot.botBid(hand, "spades", null, {
    seat: 3,
    declaredBids: [5, 4, 4, null],
  });
  assert.equal(withSum, alone);
});

test("a hand too weak to declare is not dragged into a bid", () => {
  const junk = [t(2, "hearts"), t(3, "clubs"), t(4, "diamonds")];
  const stretched = TarneebBot.botBid(junk, "spades", null, {
    seat: 3,
    declaredBids: [2, 2, 2, null],
  });
  assert.equal(stretched, 0, "let the deal redeal rather than declare on nothing");
});

test("a seat that is not last to declare ignores the running sum", () => {
  const hand = [t(14, "hearts"), t(4, "hearts"), t(5, "clubs")];
  const alone = TarneebBot.botBid(hand, "spades");
  const midway = TarneebBot.botBid(hand, "spades", null, {
    seat: 1,
    declaredBids: [2, null, null, null],
  });
  assert.equal(midway, alone, "two seats are still to come — nothing to save yet");
});

test("without table context the old lowest-card behaviour is preserved", () => {
  const hand = [t(9, "hearts"), t(3, "hearts")];
  const pick = TarneebBot.pickAutoPlayCard(hand, "hearts", trixRules, null, null);
  assert.equal(pick.rank, 3);
});

test("card counting knows when a king has become a master", () => {
  const hand = [t(13, "hearts")];
  const seen = [{ suit: "hearts", rank: 14 }];
  assert.equal(TarneebBot.isSuitMaster(hand[0], hand, seen), true);
  assert.equal(TarneebBot.isSuitMaster(hand[0], hand, []), false);
});
