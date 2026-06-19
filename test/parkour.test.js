const test = require("node:test");
const assert = require("node:assert/strict");
const ParkourGame = require("../games/parkour/ParkourGame");
const AntiCheatValidator = require("../games/parkour/AntiCheatValidator");
const { CheckpointManager } = require("../games/parkour/CheckpointManager");
const {
  buildSettlementPlan,
  validateReconciliation,
  buildIdempotencyKey,
} = require("../services/gameSettlementService");

function mkTrack() {
  return {
    checkpoints: [
      { index: 0, x: 0, y: 0, z: 10, radius: 3 },
      { index: 1, x: 0, y: 0, z: 30, radius: 3 },
      { index: 2, x: 0, y: 0, z: 60, radius: 3 },
    ],
    finishLine: { x: 0, y: 0, z: 90, radius: 5 },
    spawnPoint: { x: 0, y: 0, z: 0 },
  };
}

function mkRaceDoc(players = 2) {
  return {
    _id: "race_mongo_1",
    raceId: "pk_test_001",
    trackId: "test-track",
    state: "waiting",
    entryFee: 100,
    minPlayers: 2,
    maxPlayers: 20,
    sessionId: "sess-1",
    participants: Array.from({ length: players }, (_, i) => ({
      userId: `user_${i}`,
      seatIndex: i,
      displayName: `P${i}`,
      buyIn: 100,
      ready: false,
      status: "active",
      lastCheckpoint: -1,
      checkpointsReached: [],
    })),
  };
}

test("state machine — valid transitions only", () => {
  const game = new ParkourGame(mkRaceDoc(), mkTrack());
  assert.equal(game.canTransition("countdown"), true);
  assert.equal(game.canTransition("playing"), false);
  game.transition("countdown");
  game.transition("starting");
  game.startRace();
  assert.equal(game.state, "playing");
});

test("2 players — ready and countdown", () => {
  const game = new ParkourGame(mkRaceDoc(2), mkTrack());
  game.setReady("user_0", true);
  game.setReady("user_1", true);
  assert.equal(game.allReady(), true);
  const cd = game.startCountdownIfReady();
  assert.ok(cd);
  assert.equal(game.state, "countdown");
});

test("20 players — all can join waiting room", () => {
  const game = new ParkourGame(mkRaceDoc(0), mkTrack());
  for (let i = 0; i < 20; i++) {
    const r = game.addPlayer({ userId: `u${i}`, buyIn: 50 });
    assert.equal(r.success, true);
  }
  const r21 = game.addPlayer({ userId: "u21", buyIn: 50 });
  assert.equal(r21.success, false);
  assert.equal(r21.reason, "race_full");
});

test("checkpoint order validation", () => {
  const game = new ParkourGame(mkRaceDoc(), mkTrack());
  game.state = "playing";
  game.raceStartedAt = Date.now();
  const nonce = "nonce_cp_00123456";
  const r0 = game.reachCheckpoint("user_0", 0, { x: 0, y: 0, z: 10, t: Date.now() }, nonce);
  assert.equal(r0.success, true);
  const bad = game.reachCheckpoint("user_0", 2, { x: 0, y: 0, z: 30, t: Date.now() + 500 }, "nonce_cp_00223456");
  assert.equal(bad.success, false);
  assert.equal(bad.reason, "wrong_checkpoint_order");
});

test("finish without checkpoints rejected", () => {
  const game = new ParkourGame(mkRaceDoc(), mkTrack());
  game.state = "playing";
  game.raceStartedAt = Date.now();
  const fin = game.finishRace("user_0", { x: 0, y: 0, z: 90, t: Date.now() }, "finish_nonce_12345678");
  assert.equal(fin.success, false);
  assert.equal(fin.reason, "checkpoints_incomplete");
});

test("simultaneous finish — unique finish order", () => {
  const game = new ParkourGame(mkRaceDoc(), mkTrack());
  game.state = "playing";
  game.raceStartedAt = Date.now() - 5000;
  for (const uid of ["user_0", "user_1"]) {
    const zByCp = [10, 30, 60];
    for (let cp = 0; cp < 3; cp++) {
      game.reachCheckpoint(
        uid,
        cp,
        { x: 0, y: 0, z: zByCp[cp], t: Date.now() + cp },
        `cp_${uid}_${cp}_12345678`
      );
    }
  }
  const f0 = game.finishRace("user_0", { x: 0, y: 0, z: 90, t: Date.now() }, "finish_u0_12345678");
  const f1 = game.finishRace("user_1", { x: 0, y: 0, z: 90, t: Date.now() }, "finish_u1_12345678");
  assert.equal(f0.success, true);
  assert.equal(f1.success, true);
  assert.notEqual(f0.finishOrder, f1.finishOrder);
});

test("duplicate finish packet rejected", () => {
  const game = new ParkourGame(mkRaceDoc(), mkTrack());
  game.state = "playing";
  game.raceStartedAt = Date.now();
  const zByCp = [10, 30, 60];
  for (let cp = 0; cp < 3; cp++) {
    game.reachCheckpoint(
      "user_0",
      cp,
      { x: 0, y: 0, z: zByCp[cp], t: Date.now() + cp * 100 },
      `cp_dup_${cp}_12345678`
    );
  }
  const nonce = "finish_dup_12345678";
  const f1 = game.finishRace("user_0", { x: 0, y: 0, z: 90, t: Date.now() }, nonce);
  assert.equal(f1.success, true);
  const f2 = game.finishRace("user_0", { x: 0, y: 0, z: 90, t: Date.now() }, nonce);
  assert.equal(f2.success, false);
});

test("anti-cheat — impossible speed", () => {
  const ac = new AntiCheatValidator({ maxSpeed: 10 });
  const from = { x: 0, y: 0, z: 0, t: 1000 };
  const to = { x: 100, y: 0, z: 0, t: 1100 };
  const r = ac.validateMovement(from, to);
  assert.equal(r.valid, false);
  assert.equal(r.reason, "impossible_speed");
});

test("anti-cheat — replay nonce", () => {
  const ac = new AntiCheatValidator();
  const n = "replay_test_12345678";
  assert.equal(ac.consumeNonce(n).valid, true);
  assert.equal(ac.consumeNonce(n).valid, false);
  assert.equal(ac.consumeNonce(n).reason, "replay_nonce");
});

test("anti-cheat — teleport on checkpoint", () => {
  const ac = new AntiCheatValidator();
  const r = ac.validateTeleportAttempt({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 200 }, 30);
  assert.equal(r.valid, false);
  assert.equal(r.reason, "teleport_detected");
});

test("disconnect then forfeit after timeout", () => {
  const game = new ParkourGame(mkRaceDoc(), mkTrack());
  game.state = "playing";
  game.markDisconnected("user_0");
  assert.equal(game.getPlayer("user_0").status, "disconnected");
  const forfeited = game.checkDisconnectForfeits(Date.now() + 70000);
  assert.deepEqual(forfeited, ["user_0"]);
});

test("reconnect restores checkpoint respawn", () => {
  const game = new ParkourGame(mkRaceDoc(), mkTrack());
  game.state = "playing";
  game.getPlayer("user_0").lastCheckpoint = 1;
  game.markDisconnected("user_0");
  const r = game.reconnect("user_0", "sock_new");
  assert.equal(r.success, true);
  assert.equal(r.lastCheckpoint, 1);
  assert.equal(r.respawn.z, 30);
});

test("parkour settlement — weighted finish order", () => {
  const participants = [
    { userId: "u0", seatIndex: 0, buyIn: 1000, isBot: false },
    { userId: "u1", seatIndex: 1, buyIn: 1000, isBot: false },
  ];
  const plan = buildSettlementPlan({
    gameType: "parkour",
    gameResult: {
      finishers: [
        { seatIndex: 0, finishOrder: 1 },
        { seatIndex: 1, finishOrder: 2 },
      ],
      positionWeights: [10, 6],
    },
    participants,
    rakePercent: 5,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  assert.equal(plan.totalBuyIn, 2000);
  assert.ok(plan.participants[0].payout > plan.participants[1].payout);
});

test("settlement idempotency key stable for same race result", () => {
  const result = { finishers: [{ seatIndex: 0, finishOrder: 1, finishTimeMs: 5000 }] };
  const k1 = buildIdempotencyKey({ tableId: "abc", gameType: "parkour", sessionId: "s1", gameResult: result });
  const k2 = buildIdempotencyKey({ tableId: "abc", gameType: "parkour", sessionId: "s1", gameResult: result });
  assert.equal(k1, k2);
});

test("CheckpointManager — finish requires last checkpoint", () => {
  const cm = new CheckpointManager(mkTrack());
  assert.equal(cm.validateFinish({ lastCheckpoint: 1, position: { x: 0, y: 0, z: 90 } }).valid, false);
  assert.equal(cm.validateFinish({ lastCheckpoint: 2, position: { x: 0, y: 0, z: 90 } }).valid, true);
});
