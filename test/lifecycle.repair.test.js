// Production Lifecycle Repair — backend invariants.
// This suite grows step-by-step; Step 2 covers the additive revision envelope.
const test = require("node:test");
const assert = require("node:assert/strict");
const TrixGame = require("../games/trix/TrixGame");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");

async function mkTrix() {
  const game = new TrixGame("rev_trix", { mongoTableId: "rev_trix" });
  // Unit env has no Mongo; the real cosmetics resolve queries the DB. Stub it
  // so startGame() completes deterministically (identity/envelope unaffected).
  game.applyCosmeticsToPlayers = async () => {};
  for (let i = 0; i < 4; i += 1) {
    game.players.push({
      userId: `u${i}`,
      socketId: `s${i}`,
      seatIndex: i,
      isBot: i >= 2,
      displayName: `P${i}`,
      chips: 1000,
    });
  }
  await game.startGame();
  game.clearBotTimer();
  return game;
}

function mkTarneeb() {
  const game = new Tarneeb41Game("rev_t41", { mongoTableId: "rev_t41" });
  for (let i = 0; i < 4; i += 1) {
    game.players.push({
      userId: `u${i}`,
      socketId: `s${i}`,
      seatIndex: i,
      isBot: false,
      displayName: `P${i}`,
      chips: 1000,
    });
  }
  return game;
}

function cleanup(game) {
  try {
    if (typeof game.clearBotTimer === "function") game.clearBotTimer();
    if (typeof game.clearTurnTimer === "function") game.clearTurnTimer();
    if (typeof game.destroy === "function") game.destroy();
  } catch (_) {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Step 2 — revision envelope
// ---------------------------------------------------------------------------

test("Step2: BaseGameEngine revision counter starts at 0 and bumps monotonically", () => {
  const game = mkTarneeb();
  try {
    assert.equal(game.stateRevision, 0);
    assert.equal(game.bumpStateRevision(), 1);
    assert.equal(game.bumpStateRevision(), 2);
    assert.equal(game.stateRevision, 2);
  } finally {
    cleanup(game);
  }
});

test("Step2: getLifecyclePhase maps engine states onto the shared vocabulary", () => {
  const game = mkTarneeb();
  try {
    const cases = {
      waiting: "waiting",
      countdown: "waiting",
      bidding_syrian: "playing",
      playing: "playing",
      round_end: "showdown",
      game_end: "showdown",
    };
    for (const [state, phase] of Object.entries(cases)) {
      game.state = state;
      assert.equal(game.getLifecyclePhase(), phase, `state=${state}`);
    }
  } finally {
    cleanup(game);
  }
});

test("Step2: Trix getGameState carries the additive envelope and reflects a bump", async () => {
  const game = await mkTrix();
  try {
    const s1 = game.getGameState(0);
    assert.ok(s1, "gameState present after startGame");
    assert.equal(typeof s1.stateRevision, "number");
    assert.equal(s1.stateRevision, 0);
    assert.equal(s1.sessionPhase, "playing"); // selecting_game → playing
    assert.ok("roundId" in s1);

    game.bumpStateRevision();
    const s2 = game.getGameState(0);
    assert.equal(s2.stateRevision, 1, "snapshot reflects the bump");
  } finally {
    cleanup(game);
  }
});

test("Step2: Tarneeb41 getGameState carries the additive envelope", () => {
  const game = mkTarneeb();
  try {
    const s = game.getGameState(0);
    assert.equal(typeof s.stateRevision, "number");
    assert.equal(s.sessionPhase, "waiting");
    assert.ok("roundId" in s);
  } finally {
    cleanup(game);
  }
});

test("Step2: turn_timer payloads carry stateRevision (both engines)", async () => {
  const trix = await mkTrix();
  try {
    const p = trix._turnTimerPayload();
    assert.equal(typeof p.stateRevision, "number");
  } finally {
    cleanup(trix);
  }

  const t41 = mkTarneeb();
  try {
    const p = t41._turnTimerPayload();
    assert.equal(typeof p.stateRevision, "number");
  } finally {
    cleanup(t41);
  }
});

// ---------------------------------------------------------------------------
// Step 3 — intentional leave finalizes immediately (no ghost) + idempotency
// ---------------------------------------------------------------------------

test("Step3: convertHumanToBot flips the seat to a bot immediately with no grace deadline", () => {
  const game = mkTarneeb();
  try {
    game.players[1].reconnectDeadline = Date.now() + 60000; // as if scheduled
    const ok = game.convertHumanToBot("u1");
    assert.equal(ok, true);
    const seat = game.players[1];
    assert.equal(seat.isBot, true, "seat is now a bot");
    assert.equal(seat.reconnectDeadline, null, "grace deadline cleared");
    assert.notEqual(String(seat.userId), "u1", "human id replaced — no ghost");
  } finally {
    cleanup(game);
  }
});

test("Step3: convertHumanToBot is idempotent — a second call for the same human no-ops", () => {
  const game = mkTarneeb();
  try {
    assert.equal(game.convertHumanToBot("u2"), true);
    assert.equal(game.convertHumanToBot("u2"), false, "human already gone");
  } finally {
    cleanup(game);
  }
});

test("Step3: finalizeCardTableVacateNow is exported (immediate intentional-leave path)", () => {
  const svc = require("../services/cardTableVacateService");
  assert.equal(typeof svc.finalizeCardTableVacateNow, "function");
});

// ---------------------------------------------------------------------------
// Step 4 — Trix roster sync + Tarneeb round_end auto-advance
// ---------------------------------------------------------------------------

test("Step4: Trix convertHumanToBot syncs the gameState roster (kills the ghost + drives the bot loop)", async () => {
  const game = await mkTrix();
  try {
    const seat = 0; // u0 is a human (mkTrix bots are seats 2,3)
    assert.equal(game.gameState.players[seat].isBot, false);

    game.convertHumanToBot("u0");

    assert.equal(game.players[seat].isBot, true, "lobby row flipped");
    assert.equal(
      game.gameState.players[seat].isBot,
      true,
      "gameState roster flipped — no ghost, and checkBotTurn will drive the seat"
    );
    assert.equal(
      game.gameState.players[seat].name,
      game.players[seat].displayName,
      "gameState name matches the bot identity"
    );
  } finally {
    cleanup(game);
  }
});

test("Step4: Trix replaceBotWithHuman restores the gameState roster", async () => {
  const game = await mkTrix();
  try {
    const seat = 0;
    game.convertHumanToBot("u0");
    assert.equal(game.gameState.players[seat].isBot, true);

    await game.replaceBotWithHuman(seat, "u0-new", "sock-new", "Restored", {
      allowTakeover: true,
    });

    assert.equal(game.players[seat].isBot, false, "lobby row restored");
    assert.equal(
      game.gameState.players[seat].isBot,
      false,
      "gameState roster restored"
    );
  } finally {
    cleanup(game);
  }
});

test("Step4: Tarneeb41 arms a round_end auto-advance timer (idle-human stall fix)", () => {
  const game = mkTarneeb();
  try {
    // Enter round_end deterministically (no DB): valid bids/tricks, no game-end.
    game.declaredBids = [4, 3, 4, 2];
    game.tricksThisRound = [4, 3, 3, 3];
    game.playerScores = [0, 0, 0, 0];
    game.endRound();

    assert.equal(game.state, "round_end");
    assert.notEqual(
      game._roundEndTimerId,
      null,
      "auto-advance timer armed — a connected idle human can no longer stall forever"
    );

    // A human clicking Continue (next_round) clears the pending auto-advance.
    game._clearRoundEndAutoAdvance();
    assert.equal(game._roundEndTimerId, null);
  } finally {
    cleanup(game);
  }
});

// ---------------------------------------------------------------------------
// Step 5 — poker FrozenReason (additive, observational)
// ---------------------------------------------------------------------------

test("Step5: chip-auditor freeze stamps frozenReason (no settlement math touched)", async () => {
  const { auditOrFreeze } = require("../utils/poker/chipAuditor");
  const game = {
    frozen: false,
    frozenReason: null,
    running: true,
    // actual = 100 + 999 + 0 = 1099, expected = 100 → delta 999 → violation
    seats: [{ chips: 100, bet: 0 }],
    pot: 999,
    uncollectedRake: 0,
    handStartTotal: 100,
    tableId: "t",
    currentHandId: "h",
    clearActionScheduling() {},
    clearTurnTimer() {},
    clearBotFillTimer() {},
    async broadcastState() {},
  };
  const ok = await auditOrFreeze(game, "test");
  assert.equal(ok, false, "conservation violation → not ok");
  assert.equal(game.frozen, true);
  assert.equal(game.frozenReason, "chip_conservation");
});

// ---------------------------------------------------------------------------
// Step 6 — heartbeat resync resolves the seat from the authenticated user
// ---------------------------------------------------------------------------

test("Step6: heartbeat resync uses the userId-resolved seat (own hand only, no leak)", async () => {
  const game = await mkTrix(); // seats 0,1 human (u0,u1); 2,3 bots
  try {
    // Mirror the server handler's seat resolution for the authenticated user.
    const seatIdx = game.players.findIndex(
      (p) => p && !p.isBot && p.userId && String(p.userId) === "u1"
    );
    assert.equal(seatIdx, 1, "seat resolved from userId, not a client-sent index");

    const state = game.getGameState(seatIdx);
    assert.ok(
      Array.isArray(state.hands[1]) && state.hands[1].every((c) => c && c.rank),
      "requesting seat sees its own cards"
    );
    assert.ok(
      state.hands[0].every((c) => c === null),
      "opponent hand is hidden in the resync snapshot"
    );
    assert.equal(typeof state.stateRevision, "number");
  } finally {
    cleanup(game);
  }
});

// ---------------------------------------------------------------------------
// Step 7 — structured lifecycle audit log
// ---------------------------------------------------------------------------

test("Step7: lifecycleAudit emits a structured event and never throws", () => {
  const { lifecycleAudit } = require("../utils/lifecycleAudit");
  assert.equal(typeof lifecycleAudit, "function");
  assert.doesNotThrow(() =>
    lifecycleAudit("JOIN", { gameType: "trix", tableId: "t", userId: "u" })
  );
  assert.doesNotThrow(() => lifecycleAudit("FROZEN")); // tolerates no fields
});

// ---------------------------------------------------------------------------
// Seat-claim repair — Trix bot-seat takeover (engine-level, DB-independent)
// ---------------------------------------------------------------------------

test("SeatClaim: Trix listReplaceableBotSeats reports vacated bot seats", async () => {
  const game = await mkTrix(); // seats 0,1 human (u0,u1); 2,3 bots
  try {
    game.convertHumanToBot("u0"); // seat 0 → vacate bot
    const botSeats = game.listReplaceableBotSeats();
    const seat0 = botSeats.find((b) => b.seatIndex === 0);
    assert.ok(seat0, "seat 0 is now a claimable bot seat");
    assert.equal(seat0.vacatedFromUserId, "u0");
    // seats 2,3 are native bots (no vacatedFromUserId)
    assert.ok(botSeats.some((b) => b.seatIndex === 2));
  } finally {
    cleanup(game);
  }
});

test("SeatClaim: a NEW human can take over a Trix bot seat (allowTakeover), guard holds without it", async () => {
  const game = await mkTrix();
  try {
    game.convertHumanToBot("u0"); // seat 0 bot, vacatedFromUserId=u0
    game.convertHumanToBot("u1"); // seat 1 bot, vacatedFromUserId=u1

    // A DIFFERENT user takes seat 0 with allowTakeover → succeeds.
    const ok = await game.replaceBotWithHuman(0, "newUser", "sock-new", "New", {
      allowTakeover: true,
      chips: 500,
    });
    assert.equal(ok, true, "takeover succeeds with allowTakeover");
    assert.equal(game.players[0].isBot, false, "lobby row is human");
    assert.equal(String(game.players[0].userId), "newUser");
    assert.equal(
      game.gameState.players[0].isBot,
      false,
      "gameState roster synced (no ghost, bot loop won't drive it)"
    );

    // Without allowTakeover, a non-vacater is rejected (protects a reconnecting
    // original vacater's seat).
    const rejected = await game.replaceBotWithHuman(1, "someoneElse", "s", "X", {
      allowTakeover: false,
    });
    assert.equal(rejected, false, "allowTakeover:false rejects a non-vacater");
  } finally {
    cleanup(game);
  }
});
