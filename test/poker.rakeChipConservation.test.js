/**
 * Rake must move the chip-conservation baseline with it.
 *
 * Observed in production (table 101, 2026-09-18T03:06:26Z):
 *
 *   poker_chip_conservation_violation context:"advance_pre"
 *   expected 19000  actual 18900  delta -100  pot 0  rakeAcc 0
 *
 * The hand before it took exactly 100 in rake. Rake leaves the table at
 * settlement — it comes out of the winner's payout and is never credited to a
 * stack — but `handStartTotal`, the baseline the audit measures against, stayed
 * at the pre-hand figure. So the stacks were short by the rake, for real and
 * forever, and every audit after that hand failed by `-rake`.
 *
 * Worse, `_tryUnfreezeFromChipProbe` measures against the same stale baseline,
 * so the table could never recover on its own: one 100-chip rake froze a
 * healthy table permanently ("الطاولة متوقفة مؤقتاً").
 *
 * Two fixes, one test each below:
 *   1. settlement drops `handStartTotal` by the rake it removed;
 *   2. `advance()` bails when no hand is live — a paced advance sleeps before
 *      it runs, so the last one of a hand lands after the table has been reset
 *      and has nothing to advance.
 */
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const { PokerTable } = require("../sockets/tableGame");
const { auditChipConservation } = require("../utils/poker/chipAuditor");

function createNspStub() {
  return {
    to: () => ({ emit() {} }),
    in: () => ({ async fetchSockets() { return []; } }),
  };
}

function mkTable({ capacity = 5, stacks = [10000, 10000] } = {}) {
  const seats = stacks.map((chips, i) => ({
    user: { _id: `u${i}`, name: `P${i}` },
    chips,
    seatPosition: i,
  }));
  const g = new PokerTable(createNspStub(), {
    _id: "table-rake-audit",
    smallBlind: 100,
    bigBlind: 200,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity,
    seats,
    settings: { botsEnabled: false },
  });
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};
  g.autoRebuyBustedHumans = async () => 0;
  return g;
}

/** The state a table is in the moment a hand has settled: pot swept, no bets. */
function settleTo(game, stacks) {
  game.seats.forEach((s, i) => {
    s.chips = stacks[i];
    s.bet = 0;
    s.invested = 0;
  });
  game.pot = 0;
  game.uncollectedRake = 0;
}

test("the baseline is what the audit measures against", () => {
  const g = mkTable();
  g.handStartTotal = 20000;
  settleTo(g, [12000, 8000]);

  const probe = auditChipConservation(g, "unit");
  assert.equal(probe.ok, true, "chips only moved between seats");
  assert.equal(probe.actual, 20000);
});

test("rake taken off the table lowers the baseline by the same amount", () => {
  const g = mkTable();
  g.handStartTotal = 20000;

  // The production shape: a 1000 pot, 100 raked, winner credited 900.
  settleTo(g, [10900, 9000]);
  assert.equal(
    auditChipConservation(g, "before").ok,
    false,
    "without the fix this is the failure that froze the table",
  );
  assert.equal(auditChipConservation(g, "before").delta, -100);

  g.adjustHandBaselineForRake(100);

  const probe = auditChipConservation(g, "after");
  assert.equal(probe.ok, true);
  assert.equal(probe.expected, 19900, "the rake is gone from the table for good");
  assert.equal(probe.delta, 0);
});

test("the rake adjustment is not gated on a live hand", () => {
  // It is applied at settlement, when running is already false and the round is
  // idle — the seat-baseline helper's isHandActive() gate would drop it.
  const g = mkTable();
  g.handStartTotal = 20000;
  g.running = false;
  g.round = "idle";

  g.adjustHandBaselineForRake(100);
  assert.equal(g.handStartTotal, 19900);

  // The seat helper, by contrast, correctly ignores a dead hand.
  g.adjustHandBaselineForSeat(5000, 1);
  assert.equal(g.handStartTotal, 19900, "no hand in flight — the seat baseline holds");
});

test("a zero or missing rake changes nothing", () => {
  const g = mkTable();
  g.handStartTotal = 20000;
  for (const v of [0, null, undefined, -50, NaN]) {
    g.adjustHandBaselineForRake(v);
  }
  assert.equal(g.handStartTotal, 20000);
});

test("rake across several hands accumulates against the baseline", () => {
  const g = mkTable();
  g.handStartTotal = 20000;
  g.adjustHandBaselineForRake(100);
  g.adjustHandBaselineForRake(50);
  g.adjustHandBaselineForRake(25);
  settleTo(g, [11000, 8825]);
  assert.equal(auditChipConservation(g, "unit").ok, true);
});

test("a table already frozen by a stale baseline recovers between hands", () => {
  // This is the live table in the report: frozen, idle, stacks 100 short of a
  // baseline that was never told about the rake. Before the rebase the probe
  // measured against the same stale number, so the monitor's auto-repair could
  // never clear it — the table stayed frozen indefinitely.
  const g = mkTable();
  g.handStartTotal = 20000;
  settleTo(g, [10900, 9000]);
  g.frozen = true;
  g.frozenReason = "chip_conservation";
  g.running = false;
  g.round = "idle";

  assert.equal(g._tryUnfreezeFromChipProbe("test"), true);
  assert.equal(g.frozen, false);
  assert.equal(g.frozenReason, null);
  assert.equal(g.handStartTotal, 19900, "rebased from what is actually seated");
});

test("a live hand is never rebased — that is where the invariant has teeth", () => {
  const g = mkTable();
  g.handStartTotal = 20000;
  g.running = true;
  g.round = "flop";
  g.seats[0].chips = 9000;
  g.seats[1].chips = 9000;
  g.pot = 1500; // 500 short: a real mid-hand imbalance

  assert.equal(g._rebaseHandTotalBetweenHands("test"), false);
  assert.equal(g.handStartTotal, 20000);

  g.frozen = true;
  g.frozenReason = "chip_conservation";
  g.running = false; // the freeze stops the loop, but the round is still live
  assert.equal(
    g._tryUnfreezeFromChipProbe("test"),
    false,
    "a hand in flight with missing chips stays frozen for an admin",
  );
});

test("an already-correct baseline is left alone", () => {
  const g = mkTable();
  g.handStartTotal = 20000;
  settleTo(g, [12000, 8000]);
  g.running = false;
  g.round = "idle";
  assert.equal(g._rebaseHandTotalBetweenHands("test"), false);
  assert.equal(g.handStartTotal, 20000);
});

test("advance() does nothing when no hand is live", async () => {
  const g = mkTable();
  g.running = false;
  g.round = "idle";
  // A baseline that would fail the audit, to prove advance never reaches it.
  g.handStartTotal = 20000;
  settleTo(g, [10900, 9000]);

  let audited = false;
  g.auditChipConservation = async () => {
    audited = true;
    return false;
  };

  await g.advance();

  assert.equal(audited, false, "a table between hands is not audited by advance");
  assert.equal(g.frozen, false, "and a stray paced advance cannot freeze it");
});

test("advance() still audits a hand in flight", async () => {
  const g = mkTable();
  g.running = true;
  g.round = "flop";

  let audited = false;
  g.auditChipConservation = async (context) => {
    if (context === "advance_pre") audited = true;
    return false; // stop the advance right after the audit
  };

  await g.advance();
  assert.equal(audited, true, "the guard must not disarm the real check");
});
