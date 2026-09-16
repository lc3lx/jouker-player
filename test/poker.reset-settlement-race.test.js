/**
 * The last human leaving mid-hand used to wipe the engine's seats while the
 * showdown tail / settlement was still indexing them, throwing
 * "Cannot read properties of undefined (reading 'isBot')" and leaving the table
 * wedged with no final broadcast — every client stuck on "syncing" until it
 * backed out to the lobby and rejoined.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { PokerTable } = require("../sockets/tableGame");
const { POKER_CAPACITY } = require("../utils/pokerTableStatus");

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

function mkGame(humanCount = 2) {
  const seats = Array.from({ length: humanCount }, (_, i) => ({
    user: { _id: `u${i}`, name: `P${i}` },
    chips: 100000,
    seatPosition: i,
  }));
  const g = new PokerTable(createNspStub(), {
    _id: "table-race",
    smallBlind: 1000,
    bigBlind: 2000,
    minBuyIn: 100000,
    maxBuyIn: 100000,
    capacity: POKER_CAPACITY,
    seats,
  });
  g.broadcastState = async () => {
    g.broadcasts = (g.broadcasts || 0) + 1;
  };
  g.syncMongoTableStatus = async () => {};
  g.autoRebuyBustedHumans = async () => 0;
  // No Mongo in unit tests — the empty-reset retry must simply stay quiet.
  g.resetIfMongoHasNoSeats = async () => false;
  return g;
}

test("a reset defers instead of wiping seats while a hand holds the action lock", async () => {
  const g = mkGame(2);
  g.running = true;
  g.round = "showdown";
  g.pot = 5000;

  // Stand in for the showdown tail / settlement: it owns the lock across awaits.
  const held = await g.acquireActionLock();
  assert.equal(held, true);

  const outcome = await g.resetToEmptyIdle({ seats: [], capacity: 9 });

  assert.equal(outcome.deferred, true);
  assert.equal(outcome.reset, false);
  assert.equal(g.seats.length, 2, "the settling hand keeps its seats");
  assert.equal(g.pot, 5000, "the pot is not cleared out from under settlement");

  await g.releaseActionLock();
});

test("a reset goes through once the hand releases the lock", async () => {
  const g = mkGame(2);
  g.running = true;
  g.round = "showdown";
  g.pot = 5000;
  g.community = ["As", "Kd", "2c"];

  const outcome = await g.resetToEmptyIdle({ seats: [], capacity: 9 });

  assert.equal(outcome.deferred, false);
  assert.equal(outcome.reset, true);
  assert.equal(g.seats.length, 0);
  assert.equal(g.running, false);
  assert.equal(g.round, "idle");
  assert.equal(g.pot, 0);
  assert.deepEqual(g.community, []);
});

test("a deferred reset leaves the action lock to its owner", async () => {
  const g = mkGame(2);
  g.running = true;
  g.round = "showdown";
  await g.acquireActionLock();

  await g.resetToEmptyIdle({ seats: [], capacity: 9 });

  // The holder still owns it: a fresh acquire must fail until it releases.
  assert.equal(await g.acquireActionLock(), false);
  await g.releaseActionLock();
  assert.equal(await g.acquireActionLock(), true);
  await g.releaseActionLock();
});

test("next-dealer selection survives a table emptied mid-settlement", () => {
  const g = mkGame(3);
  g.dealerIndex = 0;
  // seatOrderFrom still returns the indices of the hand that was dealt, but a
  // reset has since emptied the live array — picking the next dealer used to
  // dereference undefined rows and throw out of settlement.
  const order = g.seatOrderFrom(g.dealerIndex);
  assert.ok(order.length > 0);
  g.seats = [];

  assert.doesNotThrow(() => {
    const next = order.find((i) => Number(g.seats[i]?.chips ?? 0) > 0) ?? g.dealerIndex;
    assert.equal(next, g.dealerIndex, "falls back to the current dealer");
  });
});

test("a bot turn serializes under the action lock like a human action", async () => {
  const g = mkGame(2);
  g.running = true;
  g.round = "preflop";
  g.currentIndex = 0;
  g.seats[0].isBot = true;
  g.seats[0].inHand = true;

  let lockHeldDuringTurn = null;
  g._playBotTurnLocked = async () => {
    // Whatever the bot does, a concurrent reset must not get the lock.
    lockHeldDuringTurn = (await g.acquireActionLock()) === false;
  };

  await g.playBotTurn(0);

  assert.equal(lockHeldDuringTurn, true, "the bot holds the lock while it acts");
  assert.equal(await g.acquireActionLock(), true, "and releases it afterwards");
  await g.releaseActionLock();
});

test("a reset cannot wipe seats while a bot turn is settling the hand", async () => {
  const g = mkGame(2);
  g.running = true;
  g.round = "showdown";
  g.currentIndex = 0;
  g.seats[0].isBot = true;
  g.seats[0].inHand = true;

  let outcome = null;
  g._playBotTurnLocked = async () => {
    // Stand in for the showdown tail + settlement the bot turn carries.
    outcome = await g.resetToEmptyIdle({ seats: [], capacity: 9 });
  };

  await g.playBotTurn(0);

  assert.equal(outcome.deferred, true);
  assert.equal(g.seats.length, 2, "settlement keeps the seats it is resolving");
});

test("a failed action loop heals to a renderable idle and broadcasts", async () => {
  const g = mkGame(2);
  g.running = true;
  g.round = "flop";
  g.pot = 4000;
  g.broadcasts = 0;
  g.scheduleNextHand = () => {
    g.nextHandScheduled = true;
  };

  await g.healAfterActionLoopFailure("bot_turn");

  assert.equal(g.running, false);
  assert.equal(g.round, "idle", "clients get a state they can render");
  assert.equal(g.pot, 0);
  assert.ok(g.broadcasts > 0, "the table tells its clients it recovered");
  assert.equal(g.nextHandScheduled, true, "play resumes for the seated humans");
});

test("healing a frozen table does not resurrect it", async () => {
  const g = mkGame(2);
  g.frozen = true;
  g.frozenReason = "chip_conservation";
  g.running = false;
  g.round = "flop";

  await g.healAfterActionLoopFailure("bot_turn");

  assert.equal(g.frozen, true);
  assert.equal(g.frozenReason, "chip_conservation");
  assert.equal(g.round, "flop", "a frozen table stays exactly as the audit left it");
});
