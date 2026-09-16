/**
 * A bot must never lock a paying player out of a poker table.
 *
 * With POKER_BOT_FILL_TARGET defaulting to the full capacity, one seated human
 * leaves the live engine holding all nine chairs with bots. Every later joiner
 * is written to Mongo but has to be given a live chair too — by taking one from
 * a bot — otherwise only the first player at a table can ever play.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { PokerTable } = require("../sockets/tableGame");
const { POKER_CAPACITY } = require("../utils/pokerTableStatus");
const { auditChipConservation } = require("../utils/poker/chipAuditor");

function createNspStub() {
  return {
    to() {
      return { emit() {} };
    },
    in() {
      return {
        async fetchSockets() {
          return [];
        },
      };
    },
  };
}

function mkGame(humanCount = 1) {
  const seats = Array.from({ length: humanCount }, (_, i) => ({
    user: { _id: `u${i}`, name: `P${i}` },
    chips: 100000,
    seatPosition: i,
  }));
  const g = new PokerTable(createNspStub(), {
    _id: "table-takeover",
    smallBlind: 1000,
    bigBlind: 2000,
    minBuyIn: 100000,
    maxBuyIn: 100000,
    capacity: POKER_CAPACITY,
    seats,
  });
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};
  g.autoRebuyBustedHumans = async () => 0;
  return g;
}

/** Fill the table with bots exactly the way a live solo-human table does. */
function fillWithBots(game) {
  game.addBotsForMissingSeats();
  return game;
}

/** Put the table into a dealt hand with every current seat in play. */
function dealHand(game) {
  game.running = true;
  game.round = "preflop";
  for (const s of game.seats) {
    s.inHand = true;
    s.invested = 0;
    s.bet = 0;
  }
  game.pot = 0;
  game.handStartTotal = game.seats.reduce((sum, s) => sum + s.chips, 0);
}

test("one human + bot fill occupies every chair", () => {
  const g = fillWithBots(mkGame(1));
  assert.equal(g.seats.length, POKER_CAPACITY);
  assert.equal(g.seats.filter((s) => s.isBot).length, POKER_CAPACITY - 1);
});

test("a second human takes a bot chair on a bot-full idle table", () => {
  const g = fillWithBots(mkGame(1));
  const chair = g.makeRoomForHumanChair(null);
  assert.notEqual(chair, null);
  assert.equal(g.seats.length, POKER_CAPACITY - 1, "a bot gave up its chair");
  assert.ok(
    !g.seats.some((s) => Number(s.seatPosition) === chair),
    "the returned chair is free"
  );
});

test("a player who picks a bot's chair gets that exact chair", () => {
  const g = fillWithBots(mkGame(1));
  const botChair = Number(g.seats.find((s) => s.isBot).seatPosition);
  const chair = g.makeRoomForHumanChair(botChair);
  assert.equal(chair, botChair);
  assert.ok(!g.seats.some((s) => Number(s.seatPosition) === botChair));
});

test("a human's chair is never taken from them", () => {
  const g = fillWithBots(mkGame(1));
  const humanChair = Number(g.seats.find((s) => !s.isBot).seatPosition);
  const chair = g.makeRoomForHumanChair(humanChair);
  assert.notEqual(chair, humanChair);
  assert.ok(
    g.seats.some((s) => !s.isBot && Number(s.seatPosition) === humanChair),
    "the seated human stays put"
  );
});

test("mid-hand, bots with chips in the pot are not evicted", () => {
  const g = fillWithBots(mkGame(1));
  dealHand(g);
  assert.equal(g.listReplaceableBotSeats().length, 0);
  assert.equal(g.makeRoomForHumanChair(null), null, "the join waits for the hand");
  assert.equal(g.seats.length, POKER_CAPACITY, "no seat was disturbed");
});

test("mid-hand, a bot that is not in the hand yields its chair", () => {
  const g = fillWithBots(mkGame(1));
  dealHand(g);
  // A bot that joined after the deal (scheduleBotFillIfNeeded) sits out the hand.
  const latecomer = g.seats.find((s) => s.isBot);
  latecomer.inHand = false;
  const chair = g.makeRoomForHumanChair(Number(latecomer.seatPosition));
  assert.equal(chair, Number(latecomer.seatPosition));
  assert.equal(g.seats.length, POKER_CAPACITY - 1);
});

test("mid-hand bot fill keeps chip conservation balanced", () => {
  const g = fillWithBots(mkGame(1));
  dealHand(g);
  // Drop two bots the way a bust does, then let the fill timer top the table up.
  g.seats = g.seats.filter((s) => !s.isBot || g.seats.indexOf(s) < 7);
  g.handStartTotal = g.seats.reduce((sum, s) => sum + s.chips, 0);
  assert.ok(auditChipConservation(g, "before_fill").ok);

  g.addBotsForMissingSeats();
  assert.ok(
    auditChipConservation(g, "after_fill").ok,
    "a mid-hand bot fill must not look like invented chips"
  );
});

test("mid-hand bot eviction keeps chip conservation balanced", () => {
  const g = fillWithBots(mkGame(1));
  dealHand(g);
  const victim = g.seats.find((s) => s.isBot);
  victim.inHand = false;
  assert.ok(auditChipConservation(g, "before_evict").ok);

  g.makeRoomForHumanChair(Number(victim.seatPosition));
  assert.ok(
    auditChipConservation(g, "after_evict").ok,
    "removing a bot stack must move the audit baseline with it"
  );
});

test("evicting a bot keeps dealer / turn pointing at the same players", () => {
  const g = fillWithBots(mkGame(1));
  dealHand(g);
  g.dealerIndex = g.seats.length - 1;
  g.currentIndex = g.seats.length - 2;
  const dealerId = g.seats[g.dealerIndex].userId;
  const currentId = g.seats[g.currentIndex].userId;

  const victim = g.seats[0].isBot ? g.seats[0] : g.seats[1];
  victim.inHand = false;
  g.makeRoomForHumanChair(Number(victim.seatPosition));

  assert.equal(g.seats[g.dealerIndex].userId, dealerId);
  assert.equal(g.seats[g.currentIndex].userId, currentId);
});
