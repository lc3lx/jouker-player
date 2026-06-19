/**
 * Lightweight stress script: simulate multiple Tarneeb41 table game instances
 * with bot-filled seats and rapid declare/play cycles.
 *
 * Usage: node scripts/tarneeb41-stress.js [tableCount] [roundsPerTable]
 */
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
const rules = require("../games/tarneeb41/tarneeb41.rules");

const tableCount = Math.max(1, parseInt(process.argv[2] || "5", 10));
const roundsPerTable = Math.max(1, parseInt(process.argv[3] || "3", 10));

function mkTable(index) {
  const game = new Tarneeb41Game(`stress_${index}`, { mongoTableId: `stress_${index}` });
  for (let i = 0; i < 4; i += 1) {
    game.players.push({
      userId: i < 2 ? `human_${index}_${i}` : `bot_${index}_${i}`,
      socketId: i < 2 ? `sock_${index}_${i}` : null,
      seatIndex: i,
      isBot: i >= 2,
      displayName: i >= 2 ? "بوت" : `Human ${i}`,
      chips: 1000,
    });
  }
  return game;
}

function playBiddingRound(game) {
  let guard = 0;
  while (game.state === "bidding_syrian" && guard < 40) {
    const idx = game.currentPlayerIndex;
    const value = 3 + (idx % 4);
    game.applyMove(idx, "tarneeb41_declare", { value, moveId: `bid_${game.roomId}_${guard}` });
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
      moveId: `play_${game.roomId}_${guard}`,
    });
    if (!result.success) break;
    guard += 1;
  }
}

function runTable(index) {
  const game = mkTable(index);
  try {
    game.clearBotTimer();
    game.startGame();
    let rounds = 0;
    let guard = 0;
    while (rounds < roundsPerTable && game.state !== "game_end" && guard < 50) {
      guard += 1;
      playBiddingRound(game);
      if (game.state === "bidding_syrian") break;
      playTricks(game);
      if (game.state === "round_end") {
        game.advanceNextRound();
        rounds += 1;
      }
    }
    return {
      tableId: game.roomId,
      state: game.state,
      roundNumber: game.roundNumber,
      scores: [...game.playerScores],
    };
  } finally {
    game.destroy();
  }
}

const started = Date.now();
const results = [];
for (let i = 0; i < tableCount; i += 1) {
  results.push(runTable(i));
}
const elapsed = Date.now() - started;

console.log(
  JSON.stringify(
    {
      tableCount,
      roundsPerTable,
      elapsedMs: elapsed,
      results,
    },
    null,
    2
  )
);
