/**
 * A poker table's chat belongs to one sitting, not to the table forever.
 *
 * Table chat is never stored: the server broadcasts a message and forgets it,
 * so it lives only in each client's own list — and that list was never cleared.
 * A player who stayed kept every message from everyone who had since left,
 * while the people who arrived after them saw an empty chat. The same table
 * showed two different conversations.
 *
 * A poker table is permanent, so unlike Trix/Tarneeb there is no "new game
 * object" moment to key on. The session rolls when the seated humans reach
 * zero, checked once inside `broadcastState` rather than in the six seat
 * removal paths, which are money code.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { PokerTable } = require("../sockets/tableGame");

function createNspStub() {
  return {
    to: () => ({ emit() {} }),
    in: () => ({ async fetchSockets() { return []; } }),
  };
}

function mkTable({ humans = 2 } = {}) {
  const seats = Array.from({ length: humans }, (_, i) => ({
    user: { _id: `u${i}`, name: `P${i}` },
    chips: 10000,
    seatPosition: i,
  }));
  const g = new PokerTable(createNspStub(), {
    _id: "table-session",
    smallBlind: 100,
    bigBlind: 200,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 9,
    seats,
  });
  g.syncMongoTableStatus = async () => {};
  g.autoRebuyBustedHumans = async () => 0;
  return g;
}

/** Everyone stands up. */
function emptyTheTable(game) {
  game.seats = [];
}

test("a table has a session from the moment it exists", () => {
  const g = mkTable();
  assert.ok(g.tableSessionId, "and it is on every state frame");
  assert.equal(g.getPublicState(null).tableSessionId, g.tableSessionId);
});

test("players coming and going does not end the sitting", () => {
  const g = mkTable({ humans: 3 });
  const opened = g.tableSessionId;

  g._rollTableSessionIfEmptied(); // someone is seated
  g.seats.pop(); // one leaves
  g._rollTableSessionIfEmptied();
  g.seats.pop(); // another leaves
  g._rollTableSessionIfEmptied();

  assert.equal(
    g.tableSessionId,
    opened,
    "one player is still there — it is still their conversation",
  );
});

test("the sitting ends when the last human leaves", () => {
  const g = mkTable({ humans: 1 });
  const opened = g.tableSessionId;

  g._rollTableSessionIfEmptied(); // occupied
  emptyTheTable(g);
  g._rollTableSessionIfEmptied();

  assert.notEqual(
    g.tableSessionId,
    opened,
    "the next group must not inherit this chat",
  );
});

test("an empty table does not mint a new session on every broadcast", () => {
  const g = mkTable({ humans: 1 });
  g._rollTableSessionIfEmptied();
  emptyTheTable(g);
  g._rollTableSessionIfEmptied();

  const afterEmptying = g.tableSessionId;
  for (let i = 0; i < 20; i += 1) g._rollTableSessionIfEmptied();

  assert.equal(
    g.tableSessionId,
    afterEmptying,
    "it is the edge that matters, not the level — an idle table broadcasts a lot",
  );
});

test("a table that has never been sat at keeps its opening session", () => {
  const g = mkTable({ humans: 0 });
  const opened = g.tableSessionId;
  for (let i = 0; i < 5; i += 1) g._rollTableSessionIfEmptied();
  assert.equal(g.tableSessionId, opened);
});

test("a second sitting is a second conversation", () => {
  const g = mkTable({ humans: 2 });
  const first = g.tableSessionId;

  g._rollTableSessionIfEmptied();
  emptyTheTable(g);
  g._rollTableSessionIfEmptied();
  const second = g.tableSessionId;

  // A new group sits down, plays, and leaves.
  g.seats = [{ user: { _id: "z" }, chips: 5000, seatPosition: 0 }];
  g._rollTableSessionIfEmptied();
  assert.equal(g.tableSessionId, second, "their sitting, their conversation");

  emptyTheTable(g);
  g._rollTableSessionIfEmptied();
  assert.notEqual(g.tableSessionId, second);
  assert.notEqual(g.tableSessionId, first);
});

test("bots alone do not hold a sitting open", () => {
  const g = mkTable({ humans: 1 });
  g._rollTableSessionIfEmptied();
  const opened = g.tableSessionId;

  // The human leaves; only bots remain at the table.
  g.seats = [{ userId: "bot_1", isBot: true, chips: 10000, seatPosition: 0 }];
  g._rollTableSessionIfEmptied();

  assert.notEqual(
    g.tableSessionId,
    opened,
    "nobody is left to be in a conversation",
  );
});

// ── surviving a restart ─────────────────────────────────────────────────────
//
// The snapshot is what makes a restart invisible to players mid-hand. If the
// session were re-minted on restore, every table's chat would be wiped on every
// deploy — which is worse than the bug being fixed.

test("a restart resumes the same sitting", () => {
  const g = mkTable({ humans: 2 });
  g._rollTableSessionIfEmptied();
  const live = g.tableSessionId;

  const snapshot = g.buildSnapshot ? g.buildSnapshot() : g.serialize();
  assert.equal(snapshot.tableSessionId, live, "the sitting is persisted");

  const revived = mkTable({ humans: 2 });
  assert.notEqual(revived.tableSessionId, live, "a fresh object starts fresh");
  revived.restoreFromSnapshot(snapshot);

  assert.equal(
    revived.tableSessionId,
    live,
    "restored — a deploy must not wipe a live conversation",
  );
  assert.equal(revived._hadSeatedHumans, true, "and it knows it was occupied");
});

test("an older snapshot without a session does not clear anyone's chat", () => {
  const g = mkTable({ humans: 2 });
  const opened = g.tableSessionId;

  const snapshot = g.buildSnapshot ? g.buildSnapshot() : g.serialize();
  delete snapshot.tableSessionId;
  delete snapshot.hadSeatedHumans;

  g.restoreFromSnapshot(snapshot);
  assert.equal(
    g.tableSessionId,
    opened,
    "keep what we have rather than minting one clients would read as new",
  );
});
