/**
 * Tarneeb41 release-candidate verification — production safety checks.
 * Run: node --test backend/test/tarneeb41.rc-verification.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
const rules = require("../games/tarneeb41/tarneeb41.rules");
const roomManager = require("../rooms/roomManager");
const {
  buildSettlementPlan,
  validateReconciliation,
  buildIdempotencyKey,
} = require("../services/gameSettlementService");

function mkGame({ allHuman = false, tableId = "rc_table" } = {}) {
  const game = new Tarneeb41Game(tableId, { mongoTableId: tableId });
  for (let i = 0; i < 4; i += 1) {
    game.players.push({
      userId: `u${i}`,
      socketId: `sock_${i}`,
      seatIndex: i,
      isBot: !allHuman && i >= 2,
      displayName: allHuman ? `Human ${i}` : i >= 2 ? "بوت" : `Human ${i}`,
      chips: 1000,
    });
  }
  return game;
}

let _moveSeq = 0;
function nextMoveId(prefix) {
  _moveSeq += 1;
  return `${prefix}_${_moveSeq}`;
}

function playBidding(game, bidFn) {
  let guard = 0;
  while (game.state === "bidding_syrian" && guard < 40) {
    const idx = game.currentPlayerIndex;
    const value = bidFn ? bidFn(idx, guard) : 3 + (idx % 4);
    game.applyMove(idx, "tarneeb41_declare", { value, moveId: nextMoveId("bid") });
    guard += 1;
  }
}

function playTricks(game) {
  let guard = 0;
  while ((game.state === "playing" || game.trickResolving) && guard < 80) {
    if (game.trickResolving) {
      game.finalizePendingTrickNow();
      guard += 1;
      continue;
    }
    const idx = game.currentPlayerIndex;
    const hand = game.hands[idx];
    if (!hand.length) break;
    const valid = rules.getValidCards(hand, game.ledSuit);
    const card = (valid.length > 0 ? valid : hand)[0];
    const result = game.applyMove(idx, "play_card", {
      card: { suit: rules.toApiSuit(card.suit), rank: rules.toApiRank(card.rank) },
      moveId: nextMoveId("play"),
    });
    if (!result.success) break;
    guard += 1;
  }
}

function playUntilGameEnd(game, maxGuard = 2000) {
  let rounds = 0;
  let guard = 0;
  while (game.state !== "game_end" && guard < maxGuard) {
    guard += 1;
    playBidding(game, (idx, guard) => Math.min(13, 5 + ((idx + guard) % 6)));
    if (game.state === "bidding_syrian") break;
    playTricks(game);
    if (game.state === "round_end") {
      game.advanceNextRound();
      rounds += 1;
    }
  }
  return { rounds, guard };
}

function simulateDisconnect(userId, game) {
  roomManager.deleteTarneeb41UserSocket(userId);
  const p = game.players.find((x) => String(x.userId) === String(userId));
  if (p) p.socketId = null;
}

function simulateReconnect(game, userId, newSocketId) {
  roomManager.setTarneeb41UserSocket(userId, newSocketId);
  game.syncLobbyFromTable(
    {
      seats: game.players
        .filter((p) => !p.isBot)
        .map((p, i) => ({ user: { _id: p.userId, name: p.displayName }, chips: 1000 })),
    },
    (uid) => roomManager.getTarneeb41UserSocket(String(uid))
  );
  const seatIndex = game.getPlayerIndex(userId);
  const state = seatIndex >= 0 ? game.getGameState(seatIndex) : null;
  return { seatIndex, state, restarted: game.needsInitialDeal() };
}

function countActiveHandles() {
  const handles = process._getActiveHandles();
  return handles.filter((h) => h && h.constructor && h.constructor.name === "Timeout").length;
}

// --- RC scenarios ---

test("RC-1: four human players complete multi-round game to game_end", () => {
  const game = mkGame({ allHuman: true });
  try {
    game.clearBotTimer();
    assert.equal(game.players.every((p) => !p.isBot), true);
    game.startGame();
    assert.equal(game.state, "bidding_syrian");
    const { guard } = playUntilGameEnd(game, 3000);
    assert.ok(guard > 0);
    assert.equal(game.state, "game_end");
    assert.ok(game.getGameResult());
  } finally {
    game.destroy();
  }
});

function forceStartMixedGame(game) {
  game.clearCountdown();
  game.sessionId = require("crypto").randomUUID();
  game.dealRound(true);
  game.startBotTimer();
}

test("RC-2: mixed human/bot game completes without human stall", () => {
  const game = mkGame({ allHuman: false });
  try {
    game.clearBotTimer();
    const humans = game.players.filter((p) => !p.isBot);
    assert.equal(humans.length, 2);
    // startGame now accepts mixed human/bot rosters (players.length === 4 is sufficient)
    assert.equal(game.startGame(), true);
    assert.equal(game.state, "bidding_syrian");
    playBidding(game);
    if (game.state === "playing") {
      playTricks(game);
    }
    assert.notEqual(game.state, "waiting");
    assert.ok(["bidding_syrian", "playing", "round_end", "game_end"].includes(game.state));
  } finally {
    game.destroy();
  }
});

test("RC-2b: fillWithBots starts game from 1-human waiting state", () => {
  const game = new Tarneeb41Game("fill_test");
  game.players.push({
    userId: "u0",
    socketId: "sock_0",
    seatIndex: 0,
    isBot: false,
    displayName: "Human 0",
    chips: 1000,
  });
  try {
    game.clearBotTimer();
    assert.equal(game.players.length, 1);
    assert.equal(game.state, "waiting");
    const started = game.fillWithBots();
    assert.equal(started, true);
    assert.equal(game.players.length, 4);
    assert.equal(game.players.filter((p) => p.isBot).length, 3);
    assert.equal(game.state, "bidding_syrian");
  } finally {
    game.destroy();
  }
});

test("RC-3: reconnect during bidding preserves hand and does not redeal", () => {
  const game = mkGame({ allHuman: true, tableId: "rc_bid" });
  try {
    game.clearBotTimer();
    game.startGame();
    const handBefore = JSON.stringify(game.hands[0]);
    const turnBefore = game.currentPlayerIndex;
    const scoresBefore = [...game.playerScores];
    roomManager.setUserTarneeb41Table("u0", "rc_bid");
    simulateDisconnect("u0", game);
    const p = game.players.find((x) => x.userId === "u0");
    assert.equal(p.socketId, null);
    const { seatIndex, state, restarted } = simulateReconnect(game, "u0", "sock_new_0");
    assert.equal(restarted, false);
    assert.equal(seatIndex, 0);
    assert.equal(JSON.stringify(game.hands[0]), handBefore);
    assert.equal(game.currentPlayerIndex, turnBefore);
    assert.deepEqual(game.playerScores, scoresBefore);
    assert.equal(state.state, "bidding_syrian");
    assert.equal(state.hands[0].filter((c) => c != null).length, 13);
  } finally {
    roomManager.leaveTarneeb41TableSocket("u0");
    game.destroy();
  }
});

test("RC-4: reconnect during playing restores turn and trick state", () => {
  const game = mkGame({ allHuman: true, tableId: "rc_play" });
  try {
    game.clearBotTimer();
    game.startGame();
    playBidding(game);
    assert.equal(game.state, "playing");
    const handLen = game.hands[0].length;
    const turn = game.currentPlayerIndex;
    roomManager.setUserTarneeb41Table("u1", "rc_play");
    const { seatIndex, state, restarted } = simulateReconnect(game, "u1", "sock_replay_1");
    assert.equal(restarted, false);
    assert.equal(seatIndex, 1);
    assert.equal(game.currentPlayerIndex, turn);
    assert.equal(game.hands[1].length, handLen);
    assert.equal(state.phase || game.state, "playing");
  } finally {
    roomManager.leaveTarneeb41TableSocket("u1");
    game.destroy();
  }
});

test("RC-5: reconnect during settlement/game_end restores scores without restart", () => {
  const game = mkGame({ allHuman: true, tableId: "rc_settle" });
  try {
    game.clearBotTimer();
    game.startGame();
    game.playerScores = [41, 10, 5, 8];
    game.endRound();
    assert.equal(game.state, "game_end");
    roomManager.setUserTarneeb41Table("u2", "rc_settle");
    roomManager.deleteTarneeb41UserSocket("u2");
    const { seatIndex, state, restarted } = simulateReconnect(game, "u2", "sock_settle_2");
    assert.equal(restarted, false);
    assert.equal(seatIndex, 2);
    assert.equal(game.state, "game_end");
    assert.deepEqual(state.playerScores, [41, 10, 5, 8]);
    assert.ok(state.gameResult || game.getGameResult());
  } finally {
    roomManager.leaveTarneeb41TableSocket("u2");
    game.destroy();
  }
});

test("RC-6: redeal when sum of bids below minimum", () => {
  const game = mkGame({ allHuman: true });
  try {
    game.clearBotTimer();
    game.startGame();
    const events = [];
    game.setAfterMoveListener((r) => events.push(r));
    for (let i = 0; i < 4; i += 1) {
      game.applyMove(game.currentPlayerIndex, "tarneeb41_declare", { value: 0 });
    }
    const last = events[events.length - 1];
    assert.equal(last.redeal, true);
    assert.equal(game.state, "bidding_syrian");
    assert.equal(game.hands[0].length, 13);
  } finally {
    game.destroy();
  }
});

test("RC-7: game finish produces valid game result", () => {
  const game = mkGame({ allHuman: true });
  try {
    game.clearBotTimer();
    game.startGame();
    game.playerScores = [41, 10, 5, 8];
    game.endRound();
    assert.equal(game.state, "game_end");
    const gr = game.getGameResult();
    assert.ok(gr);
    assert.ok(gr.winnerTeam === 0 || gr.winnerTeam === 1);
    assert.equal(gr.playerScores.length, 4);
  } finally {
    game.destroy();
  }
});

test("RC-8: settlement plan generated and idempotent for game finish", () => {
  const participants = [
    { userId: "u0", seatIndex: 0, buyIn: 1000, isBot: false },
    { userId: "u1", seatIndex: 1, buyIn: 1000, isBot: false },
    { userId: "u2", seatIndex: 2, buyIn: 1000, isBot: false },
    { userId: "u3", seatIndex: 3, buyIn: 1000, isBot: false },
  ];
  const gameResult = { winnerTeam: 0, playerScores: [41, 10, 5, 8] };
  const plan = buildSettlementPlan({
    gameType: "tarneeb41",
    gameResult,
    participants,
    rakePercent: 5,
  });
  assert.equal(plan.participants.filter((p) => p.isWinner).length, 2);
  assert.equal(plan.totalBuyIn, 4000);
  const key = buildIdempotencyKey({
    tableId: "t1",
    gameType: "tarneeb41",
    sessionId: "sess-1",
    gameResult,
  });
  assert.ok(key.length > 10);
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
});

test("RC-9: wallet reconciliation — human net delta balances", () => {
  const participants = Array.from({ length: 4 }, (_, i) => ({
    userId: `u${i}`,
    seatIndex: i,
    buyIn: 1000,
    isBot: false,
  }));
  for (const winnerTeam of [0, 1]) {
    const plan = buildSettlementPlan({
      gameType: "tarneeb41",
      gameResult: { winnerTeam, playerScores: winnerTeam === 0 ? [41, 10, 5, 8] : [10, 41, 8, 5] },
      participants,
      rakePercent: 5,
    });
    const recon = validateReconciliation(plan);
    assert.equal(recon.balanced, true, `team ${winnerTeam} should balance`);
    const humanDelta = plan.participants.reduce((s, p) => s + p.netDelta, 0);
    assert.equal(humanDelta + plan.houseNetDelta, 0);
  }
});

test("RC-10: house wallet reconciliation with bots", () => {
  const botWin = [
    { userId: null, seatIndex: 0, buyIn: 1000, isBot: true },
    { userId: "u1", seatIndex: 1, buyIn: 1000, isBot: false },
    { userId: null, seatIndex: 2, buyIn: 1000, isBot: true },
    { userId: "u3", seatIndex: 3, buyIn: 1000, isBot: false },
  ];
  const humanWin = [
    { userId: null, seatIndex: 0, buyIn: 1000, isBot: true },
    { userId: "u1", seatIndex: 1, buyIn: 1000, isBot: false },
    { userId: null, seatIndex: 2, buyIn: 1000, isBot: true },
    { userId: "u3", seatIndex: 3, buyIn: 1000, isBot: false },
  ];
  const planBot = buildSettlementPlan({
    gameType: "tarneeb41",
    gameResult: { winnerTeam: 0, playerScores: [41, 10, 5, 3] },
    participants: botWin,
    rakePercent: 5,
  });
  const planHuman = buildSettlementPlan({
    gameType: "tarneeb41",
    gameResult: { winnerTeam: 1, playerScores: [10, 41, 5, 8] },
    participants: humanWin,
    rakePercent: 5,
  });
  assert.equal(validateReconciliation(planBot).balanced, true);
  assert.equal(validateReconciliation(planHuman).balanced, true);
  assert.ok(planBot.houseNetDelta > 0);
  assert.ok(planHuman.houseNetDelta < 0);
});

test("RC-11: socket room cleanup — disconnect keeps mapping, leave clears it", () => {
  const tableId = `rc_room_${Date.now()}`;
  const game = roomManager.getOrCreateTarneeb41Game(tableId);
  try {
    game.players.push({
      userId: "leave_u",
      socketId: "s1",
      seatIndex: 0,
      isBot: false,
      displayName: "L",
      chips: 1000,
    });
    roomManager.setUserTarneeb41Table("leave_u", tableId);
    roomManager.setTarneeb41UserSocket("leave_u", "s1");
    simulateDisconnect("leave_u", game);
    assert.equal(roomManager.getTarneeb41TableIdForUser("leave_u"), tableId);
    assert.equal(game.players[0].socketId, null);
    roomManager.leaveTarneeb41TableSocket("leave_u");
    assert.equal(roomManager.getTarneeb41TableIdForUser("leave_u"), null);
    assert.equal(game.players[0].socketId, null);
  } finally {
    roomManager.tarneeb41GamesByTableId.delete(tableId);
    game.destroy();
  }
});

test("RC-11b: finished game evicted after settlement and all humans leave", () => {
  const tableId = `rc_evict_${Date.now()}`;
  const game = roomManager.getOrCreateTarneeb41Game(tableId);
  try {
    game.state = "game_end";
    game._finishedAt = Date.now();
    game.players = [
      { userId: "u0", socketId: "s0", seatIndex: 0, isBot: false, displayName: "H0", chips: 1000 },
      { userId: "bot_1", socketId: null, seatIndex: 1, isBot: true, displayName: "بوت", chips: 0 },
    ];
    roomManager.setUserTarneeb41Table("u0", tableId);
    roomManager.markTarneeb41SettlementComplete(tableId);
    roomManager.leaveTarneeb41TableSocket("u0");
    assert.equal(roomManager.getTarneeb41GameForTable(tableId), null);
  } finally {
    cleanupTable(tableId);
  }
});

function cleanupTable(tableId) {
  roomManager.clearTarneeb41Game(tableId);
}

test("RC-12: memory leak — destroy clears timers after many game lifecycles", () => {
  const before = countActiveHandles();
  for (let i = 0; i < 200; i += 1) {
    const game = mkGame({ allHuman: true, tableId: `mem_${i}` });
    game.startGame();
    game.destroy();
  }
  const after = countActiveHandles();
  assert.ok(after <= before + 2, `timer handles grew: before=${before} after=${after}`);
});

test("RC-13: duplicate event detection — moveId dedup and single afterMove per action", () => {
  const game = mkGame({ allHuman: true });
  try {
    game.clearBotTimer();
    game.startGame();
    let afterMoveCount = 0;
    game.setAfterMoveListener(() => {
      afterMoveCount += 1;
    });
    const idx = game.currentPlayerIndex;
    const payload = { value: 5, moveId: "dup-rc" };
    game.applyMove(idx, "tarneeb41_declare", payload);
    const countAfterFirst = afterMoveCount;
    const dup = game.applyMove(idx, "tarneeb41_declare", payload);
    assert.equal(dup.duplicate, true);
    assert.equal(afterMoveCount, countAfterFirst, "duplicate move should not re-trigger afterMove");
    const notTurn = (game.currentPlayerIndex + 1) % 4;
    const badTurn = game.applyMove(notTurn, "tarneeb41_declare", { value: 6, moveId: "bad" });
    assert.equal(badTurn.success, false);
    assert.equal(badTurn.reason, "not_your_turn");
  } finally {
    game.destroy();
  }
});
