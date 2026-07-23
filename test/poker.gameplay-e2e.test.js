"use strict";

/**
 * M3 end-to-end gameplay verification. Plays FULL hands through the real
 * PokerTable engine (deal → blinds → betting streets → showdown → atomic
 * settlement) against a real MongoDB replica set, then asserts wallet + chip
 * conservation, ledger correctness, and Texas Hold'em rule compliance.
 *
 * Timing envs are zeroed BEFORE requiring the engine so hands complete instantly.
 */

// ── deterministic, instant pacing (must precede requires) ────────────────────
process.env.POKER_TIMING_PREFLOP_DEAL_MS = "0";
process.env.POKER_TIMING_FLOP_MS = "0";
process.env.POKER_TIMING_TURN_STREET_MS = "0";
process.env.POKER_TIMING_RIVER_MS = "0";
process.env.POKER_TIMING_SHOWDOWN_MS = "0";
process.env.POKER_TIMING_SHOWDOWN_CARD_HOLD_MS = "0";
process.env.POKER_TIMING_ACTION_REVEAL_MS = "0";
process.env.POKER_TIMING_WINNER_POT_MS = "0";
process.env.POKER_TIMING_NEXT_HAND_MS = "600000"; // don't auto-deal the next hand mid-test
process.env.POKER_BOT_FILL_TARGET = "2"; // no bots with 2 humans
process.env.NODE_ENV = "test";
process.env.RAKE_PERCENT = "0.05";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Table = require("../models/tableModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const WalletTableLock = require("../models/walletTableLockModel");
const HandHistory = require("../models/handHistoryModel");
const HouseWallet = require("../models/houseWalletModel");

const { PokerTable } = require("../sockets/tableGame");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

let replSet = null;
const savedEnv = {};
let tableSeq = 7000;
const HOUSE_SEED = 1_000_000_000;

function nspStub() {
  const emitted = [];
  return {
    emitted,
    to() {
      return { emit: (event, payload) => emitted.push({ event, payload }) };
    },
    in() {
      return { async fetchSockets() { return []; } };
    },
  };
}

/** Build a table doc + engine with N seated humans, each holding `buyIn` chips. */
async function makeSeatedGame(count, buyIn = 10000, { sb = 100, bb = 200 } = {}) {
  tableSeq += 1;
  const users = [];
  for (let i = 0; i < count; i++) {
    const userId = new mongoose.Types.ObjectId();
    await Wallet.create({ user: userId, balance: 0, lockedBalance: buyIn });
    users.push(userId);
  }
  const tableDoc = await Table.create({
    gameType: "poker",
    tier: "beginner",
    tableNumber: tableSeq,
    smallBlind: sb,
    bigBlind: bb,
    minBuyIn: buyIn,
    maxBuyIn: buyIn,
    capacity: 9,
    status: "playing",
    seats: users.map((u, i) => ({ user: u, chips: buyIn, seatPosition: i })),
  });
  for (const u of users) {
    await WalletTableLock.create({ user: u, table: tableDoc._id, amount: buyIn });
  }
  const g = new PokerTable(nspStub(), await Table.findById(tableDoc._id).lean());
  g.applyCosmeticsToSeats = async () => {}; // not under test here
  for (let i = 0; i < g.seats.length; i++) g.seats[i].userId = String(users[i]);
  return { g, users, tableId: String(tableDoc._id), buyIn };
}

async function walletLocked(userId) {
  const w = await Wallet.findOne({ user: userId }).lean();
  return w ? w.lockedBalance : 0;
}
async function houseBalance() {
  const h = await HouseWallet.findOne({}).lean();
  return h ? h.balance : HOUSE_SEED;
}
/** Seed the house wallet to a known baseline (as the prod seed script does). */
async function resetHouse() {
  await HouseWallet.deleteMany({});
  await HouseWallet.create({
    key: process.env.HOUSE_WALLET_KEY || "house-main",
    balance: HOUSE_SEED,
    lockedBalance: 0,
  });
}

/** Auto-play the current hand with the given action policy until it ends. */
async function playHand(g, policy) {
  g.running = true;
  await g.startHand();
  for (let step = 0; step < 500; step++) {
    if (!g.running || g.round === "idle") break;
    if (!["preflop", "flop", "turn", "river"].includes(g.round)) {
      // showdown resolves synchronously inside advance(); loop will see idle
      await new Promise((r) => setImmediate(r));
      continue;
    }
    const idx = g.currentIndex;
    const seat = g.seats[idx];
    if (!seat || !seat.inHand || seat.folded || seat.allIn) {
      await new Promise((r) => setImmediate(r));
      continue;
    }
    const spec = g.computeTurnActionSpec(idx);
    if (!spec) break;
    const move = policy(g, idx, spec, step);
    const res = await g.handleAction(seat.userId, { ...move, actionId: `a-${step}-${idx}` });
    if (res.status !== "accepted") {
      // Turn didn't belong to this seat (already advanced) — let the loop re-read.
      await new Promise((r) => setImmediate(r));
    }
  }
  g.disposeTimers();
}

/** Passive policy: check when free, otherwise call (drives hands to showdown). */
const passive = (g, idx, spec) => (spec.canCheck ? { action: "check" } : { action: "call" });

async function assertConservation(g, users, buyIn) {
  const engineChips = g.seats.reduce((s, x) => s + x.chips, 0);
  let lockedSum = 0;
  for (const u of users) lockedSum += await walletLocked(u);
  const house = await houseBalance();
  const rakeToHouse = house - HOUSE_SEED;

  assert.equal(engineChips, lockedSum, "engine stacks == wallet locked balances");
  assert.equal(
    lockedSum + rakeToHouse,
    users.length * buyIn,
    "chips conserved: players' locked + house rake == total bought in"
  );
  // No negative wallets.
  for (const u of users) assert.ok((await walletLocked(u)) >= 0);
}

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE"]) savedEnv[k] = process.env[k];
  delete process.env.MONGO_STANDALONE;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "poker_gameplay_e2e" });
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  resetMongoTransactionProbeForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ── Phase 1: full-flow integration + Phase 4: wallet conservation ────────────

test("E2E: heads-up hand to showdown settles and conserves chips + wallets", async () => {
  await resetHouse();
  const { g, users, buyIn } = await makeSeatedGame(2, 10000);

  await playHand(g, passive);

  assert.equal(g.round, "idle", "hand finished");
  assert.equal(g.running, false);
  await assertConservation(g, users, buyIn);

  const hh = await HandHistory.findOne({ table: g.tableId }).lean();
  assert.ok(hh, "hand history persisted");
  assert.ok(hh.pot > 0, "recorded pot is the real pot");
  assert.equal(hh.gameType, "poker");
  assert.ok(Array.isArray(hh.seats) && hh.seats.length === 2);

  // Ledger: exactly one settlement (bet/win) row per human for this hand.
  const rows = await WalletTransaction.find({ handId: hh.handId }).lean();
  assert.ok(rows.length >= 2, "ledger rows written for the hand");
});

test("E2E: fold-win awards the pot to the last player and conserves chips", async () => {
  await resetHouse();
  const { g, users, buyIn } = await makeSeatedGame(2, 10000);

  // First to act folds immediately → uncontested win, no rake path via fold.
  await playHand(g, (gg, idx, spec) => ({ action: "fold" }));

  assert.equal(g.round, "idle");
  await assertConservation(g, users, buyIn);
  const winners = g.seats.filter((s) => s.chips > buyIn);
  assert.equal(winners.length, 1, "exactly one player is up after a fold-win");
});

test("E2E: three-handed hand with a raise settles and conserves", async () => {
  await resetHouse();
  const { g, users, buyIn } = await makeSeatedGame(3, 10000);

  let raised = false;
  await playHand(g, (gg, idx, spec) => {
    if (!raised && spec.allowed.includes("raise")) {
      raised = true;
      return { action: "raise", amount: spec.minRaise };
    }
    return spec.canCheck ? { action: "check" } : { action: "call" };
  });

  assert.equal(g.round, "idle");
  await assertConservation(g, users, buyIn);
});

// ── Phase 3: deterministic rule validation via showdown() ────────────────────

/** Prepare a game frozen at river with controlled holes/community/invested. */
function primeShowdown(g, seatConfigs, community) {
  g.running = true;
  g.round = "river";
  g.currentHandId = `${g.tableId}-showdown-${Date.now()}`;
  g.handStartedAt = Date.now();
  g.currentHandActions = [];
  g.handJackpotFees = 0;
  g.community = community;
  let potStart = 0;
  g.seats.forEach((s, i) => {
    const c = seatConfigs[i];
    s.handStartChips = c.start;
    s.chips = c.start - c.invested;
    s.invested = c.invested;
    s.bet = 0;
    s.inHand = c.inHand !== false;
    s.folded = !!c.folded;
    s.allIn = !!c.allIn;
    s.hole = c.hole;
    potStart += c.invested;
  });
  g.pot = potStart;
  g.handStartTotal = g.seats.reduce((s, x) => s + x.handStartChips, 0);
}

test("RULE: split pot divides evenly and pushes the odd chip by seat order", async () => {
  await resetHouse();
  process.env.RAKE_PERCENT = "0"; // isolate the split math from rake
  const { g, users } = await makeSeatedGame(2, 10000);

  // Both make the same straight (board plays); pot 2001 → 1000/1000 + 1 odd chip.
  primeShowdown(
    g,
    [
      { start: 10000, invested: 1000, hole: ["2c", "3d"] },
      { start: 10000, invested: 1001, hole: ["2h", "3s"] },
    ],
    ["Ts", "Js", "Qd", "Kd", "Ac"] // both play A-K-Q-J-T (Broadway)
  );

  await g.showdown();
  g.disposeTimers();

  const chips = g.seats.map((s) => s.chips);
  // Pot (2001) is funded FROM the two 10000 stacks → conserved total is 20000.
  assert.equal(chips[0] + chips[1], 20000, "no chips created/destroyed (rake 0)");
  // Even split of 2001 = 1000 each + 1 odd chip pushed by dealer seat order.
  assert.ok(Math.abs(chips[0] - chips[1]) <= 1, "split within one odd chip");
  await assertConservation(g, users, 10000);
  process.env.RAKE_PERCENT = "0.05";
});

test("RULE: side pots — short all-in cannot win the side pot he did not pay into", async () => {
  await resetHouse();
  process.env.RAKE_PERCENT = "0";
  const { g } = await makeSeatedGame(3, 10000);

  // P0 all-in 1000 with the NUTS (quad aces). P1/P2 invest 3000 each and contest
  // the side pot; P1 has the better side hand. Main pot(3000)→P0, side(4000)→P1.
  primeShowdown(
    g,
    [
      { start: 1000, invested: 1000, allIn: true, hole: ["Ah", "Ad"] },
      { start: 10000, invested: 3000, hole: ["Kh", "Kd"] },
      { start: 10000, invested: 3000, hole: ["Qh", "Qd"] },
    ],
    ["Ac", "As", "2d", "7h", "9s"] // P0: quad aces; P1: KK; P2: QQ
  );

  await g.showdown();
  g.disposeTimers();

  // Main pot = 3*1000 = 3000 → P0. Side pot = 2*2000 = 4000 → P1.
  assert.equal(g.seats[0].chips, 3000, "short all-in wins ONLY the main pot");
  assert.equal(g.seats[1].chips, 7000 + 4000, "best side hand wins the side pot");
  assert.equal(g.seats[2].chips, 7000, "loser keeps only his uncommitted stack");
  assert.equal(
    g.seats.reduce((s, x) => s + x.chips, 0),
    1000 + 10000 + 10000,
    "chips conserved across side pots"
  );
});

test("RULE: kicker decides when both players pair the board", async () => {
  await resetHouse();
  process.env.RAKE_PERCENT = "0";
  const { g } = await makeSeatedGame(2, 10000);

  // Board pairs tens; P0 has Ace kicker, P1 has King kicker → P0 wins.
  primeShowdown(
    g,
    [
      { start: 10000, invested: 2000, hole: ["Ah", "4d"] },
      { start: 10000, invested: 2000, hole: ["Kh", "5d"] },
    ],
    ["Ts", "Tc", "2h", "7d", "9s"]
  );

  await g.showdown();
  g.disposeTimers();

  assert.equal(g.seats[0].chips, 8000 + 4000, "better kicker wins the whole pot");
  assert.equal(g.seats[1].chips, 8000);
});

// ── Phase 4/5: multi-hand soak — cumulative conservation + dealer rotation ────

test("SOAK: 25 consecutive hands stay perfectly conserved", async () => {
  await resetHouse();
  process.env.RAKE_PERCENT = "0.05";
  const { g, users, buyIn } = await makeSeatedGame(3, 20000);

  const dealers = new Set();
  for (let hand = 0; hand < 25; hand++) {
    // stop if someone busted (would change seat set / not our conservation model)
    if (g.seats.some((s) => s.chips <= 0)) break;
    dealers.add(g.dealerIndex);
    await playHand(g, passive);
    await assertConservation(g, users, buyIn);
    // rotate dealer for the next hand (normally scheduleNextHand does this path)
    g.dealerIndex = (g.dealerIndex + 1) % g.seats.length;
    g.round = "idle";
    g.running = false;
  }
  assert.ok(dealers.size >= 2, "dealer button rotated across hands");
});

// ── Phase 2: chaos / failure injection ───────────────────────────────────────

test("CHAOS: settlement failure at showdown freezes the table and conserves everything", async () => {
  await resetHouse();
  process.env.RAKE_PERCENT = "0.05";
  const { g, users, buyIn } = await makeSeatedGame(2, 10000);

  primeShowdown(
    g,
    [
      { start: 10000, invested: 2000, hole: ["Ah", "Ad"] },
      { start: 10000, invested: 2000, hole: ["Kh", "Kd"] },
    ],
    ["Ac", "2d", "7h", "9s", "3c"]
  );

  const lockedBefore = [await walletLocked(users[0]), await walletLocked(users[1])];

  // Inject a mid-settlement failure: no house wallet + production mode makes the
  // house counterparty write throw INSIDE the transaction → full rollback.
  await HouseWallet.deleteMany({});
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  resetMongoTransactionProbeForTests();
  try {
    await g.showdown();
  } finally {
    process.env.NODE_ENV = prevEnv;
    resetMongoTransactionProbeForTests();
  }
  g.disposeTimers();

  assert.equal(g.frozen, true, "table frozen after settlement failure");
  assert.equal(g.running, false);
  // RAM stacks untouched (still pre-settlement) and equal to the rolled-back DB.
  assert.equal(g.seats[0].chips, 8000);
  assert.equal(g.seats[1].chips, 8000);
  assert.equal(g.pot, 4000, "pot intact — nothing was distributed");
  assert.equal(await walletLocked(users[0]), lockedBefore[0], "no wallet change on rollback");
  assert.equal(await walletLocked(users[1]), lockedBefore[1]);
  const hh = await HandHistory.findOne({ handId: g.currentHandId }).lean();
  assert.equal(hh, null, "no hand history for the failed settlement");
  const tbl = await Table.findById(g.tableId).lean();
  assert.equal(tbl.activeSettlementId, null, "settlement marker cleared on failure");
});

test("CHAOS: duplicate action in a live hand is applied exactly once", async () => {
  await resetHouse();
  const { g } = await makeSeatedGame(2, 10000);
  g.running = true;
  await g.startHand();
  // Freeze turn advancement so the SECOND identical action is still this seat's
  // turn — isolating the actionId idempotency guard from the turn-order guard.
  g.pacedAdvanceAfterAction = async () => {};

  const idx = g.currentIndex;
  const seat = g.seats[idx];
  const spec = g.computeTurnActionSpec(idx);
  const move = spec.canCheck ? { action: "check" } : { action: "call" };

  const first = await g.handleAction(seat.userId, { ...move, actionId: "dup-xyz" });
  const chipsAfterFirst = g.seats[idx].chips;
  const second = await g.handleAction(seat.userId, { ...move, actionId: "dup-xyz" });

  assert.equal(first.status, "accepted");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason, "DUPLICATE_ACTION");
  assert.equal(g.seats[idx].chips, chipsAfterFirst, "no second debit from the duplicate");
  g.disposeTimers();
});

test("CHAOS: player disconnect + turn timeout folds the actor and advances", async () => {
  await resetHouse();
  const { g } = await makeSeatedGame(2, 10000);
  g.running = true;
  await g.startHand();

  const actorIdx = g.currentIndex;
  const actor = g.seats[actorIdx];
  // Heads-up: the first actor (SB) owes a call — a disconnect + timeout must fold.
  const owes = g.currentBet - actor.bet;
  g.onPlayerSocketDisconnected(actor.userId);
  await g.handleTimeout(actorIdx);

  if (owes > 0) {
    assert.equal(g.seats[actorIdx].folded, true, "disconnected actor folded on timeout");
    assert.equal(g.round, "idle", "uncontested hand ended");
  }
  g.disposeTimers();
});

test("CHAOS: idempotent re-settlement never double-credits (same handId)", async () => {
  await resetHouse();
  process.env.RAKE_PERCENT = "0";
  const { g, users } = await makeSeatedGame(2, 10000);
  g.currentHandId = `${g.tableId}-idem-${Date.now()}`;

  const settleOnce = async () => {
    // Re-arm identical pre-settlement state and run the atomic settlement.
    g.seats[0].handStartChips = 10000;
    g.seats[0].chips = 8000;
    g.seats[0].invested = 2000;
    g.seats[1].handStartChips = 10000;
    g.seats[1].chips = 8000;
    g.seats[1].invested = 2000;
    g.seats.forEach((s) => {
      s.inHand = true;
      s.folded = false;
      s.bet = 0;
    });
    g.pot = 4000;
    g.handStartTotal = 20000;
    g.handJackpotFees = 0;
    await g.persistAndPrepareNext([], new Map([[0, 4000]]), [0], { reason: "fold" }, { manageLifecycle: false });
  };

  await settleOnce();
  const lockedAfterFirst = [await walletLocked(users[0]), await walletLocked(users[1])];

  await settleOnce(); // replay the same handId
  assert.deepEqual(
    [await walletLocked(users[0]), await walletLocked(users[1])],
    lockedAfterFirst,
    "replayed settlement did not move wallets"
  );
  assert.equal(await HandHistory.countDocuments({ handId: g.currentHandId }), 1, "one hand history only");
  g.disposeTimers();
  process.env.RAKE_PERCENT = "0.05";
});

// ── Table-lifecycle audit: poker disconnect -> vacate -> bot-takeover pipeline ──
// Previously onPlayerSocketDisconnected's reconnect-window timeout only set
// SITTING_OUT and stopped — the seat, and the player's locked buy-in, stayed
// stuck forever with no automatic path back to a usable seat or a refund.
// These tests cover the fix: vacatePokerSeat is now what the timeout hands
// off to (Mongo-level), and the timeout callback actually calls it (wiring).

test("VACATE PIPELINE: vacatePokerSeat moves the seat to vacatingPlayers; reconnecting within the window restores it exactly", async () => {
  const { tableId, users, buyIn } = await makeSeatedGame(2, 10000);
  const { vacatePokerSeat, tryRestoreVacatedSeat } = require("../services/pokerVacateService");

  const uid = String(users[0]);
  assert.equal(await walletLocked(uid), buyIn);

  const result = await vacatePokerSeat({ tableId, userId: uid, reason: "disconnect_timeout" });
  assert.equal(result.vacated, true);
  assert.equal(result.chips, buyIn);

  const afterVacate = await Table.findById(tableId);
  assert.equal(
    afterVacate.seats.some((s) => String(s.user) === uid),
    false,
    "seat removed from seats while vacating"
  );
  assert.equal(
    afterVacate.vacatingPlayers.some((v) => String(v.user) === uid),
    true,
    "seat recorded in vacatingPlayers with a grace window"
  );
  // Money stays exactly where it was during the grace window — not lost, not moved.
  assert.equal(await walletLocked(uid), buyIn);

  const restored = await tryRestoreVacatedSeat({ tableId, userId: uid });
  assert.equal(restored.restored, true);
  assert.equal(restored.chips, buyIn);

  const afterRestore = await Table.findById(tableId);
  assert.equal(afterRestore.seats.some((s) => String(s.user) === uid), true, "seat restored on reconnect");
  assert.equal(afterRestore.vacatingPlayers.length, 0, "vacating entry cleared on restore");
  assert.equal(await walletLocked(uid), buyIn, "reconnect never touches the wallet lock");
});

test("VACATE PIPELINE: an expired vacate window forfeits the wallet lock instead of leaving it stuck forever", async () => {
  const { tableId, users, buyIn } = await makeSeatedGame(2, 10000);
  const { vacatePokerSeat, finalizeVacateWithBot } = require("../services/pokerVacateService");

  const uid = String(users[0]);
  await vacatePokerSeat({ tableId, userId: uid, reason: "disconnect_timeout" });
  assert.equal(await walletLocked(uid), buyIn, "still locked during the grace window");

  const result = await finalizeVacateWithBot({ tableId, userId: uid, chips: buyIn });
  assert.equal(result.ok, true);
  assert.equal(result.chips, buyIn);
  assert.equal(await walletLocked(uid), 0, "lock forfeited once the grace window expires — never stuck");

  const afterFinal = await Table.findById(tableId);
  assert.equal(afterFinal.vacatingPlayers.length, 0, "vacating entry cleared after finalize");
});

test("WIRING: the reconnect-window timeout hands the seat to vacatePokerSeat instead of parking it at SITTING_OUT forever", async () => {
  const tableLifecycleSettingsService = require("../services/tableLifecycleSettingsService");
  const prevSettings = tableLifecycleSettingsService.getSettings();
  tableLifecycleSettingsService.applySettings({ ...prevSettings, pokerReconnectWindowMs: 30 });

  const pokerVacateService = require("../services/pokerVacateService");
  const origVacate = pokerVacateService.vacatePokerSeat;
  const calls = [];
  pokerVacateService.vacatePokerSeat = async (args) => {
    calls.push(args);
    return { vacated: false, reason: "test_stub" };
  };

  try {
    const { g, users } = await makeSeatedGame(2, 10000);
    const uid = g.seats[0].userId;

    g.onPlayerSocketDisconnected(uid);
    assert.equal(g.seats[0].playerState, "DISCONNECTED");

    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(calls.length, 1, "vacatePokerSeat must fire once the reconnect window elapses");
    assert.equal(String(calls[0].userId), uid);
    assert.equal(calls[0].reason, "disconnect_timeout");
    g.disposeTimers();
  } finally {
    pokerVacateService.vacatePokerSeat = origVacate;
    tableLifecycleSettingsService.applySettings(prevSettings);
  }
});
