/**
 * Card-bot self-play probe.
 *
 * Deals real hands and plays them out bot-vs-bot, then reports how well the
 * bots actually did — legality first (nothing here may ever play an illegal
 * card), then the numbers that say whether they are playing the game:
 *
 *   Tarneeb 41 — how often a declared bid is made. A bot that dumps its lowest
 *     card every trick makes its bid by accident; a bot that plays makes it
 *     most of the time.
 *   Trix      — penalty points per contract, against a "dumb" baseline bot that
 *     always plays its lowest legal card (what shipped before). Lower is
 *     better, so the new bot must beat the baseline by a clear margin.
 *
 *   node tool/cardBotSim.js [rounds]
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TrixBot = require("../engine/bots/TrixBot");
const TarneebBot = require("../engine/bots/TarneebBot");
const rules = require("../games/tarneeb41/tarneeb41.rules");
const { newDeck, shuffle } = require("../games/utils/cards");

const GameManager = require("../games/trix/managers/GameManager");
const RoundManager = require("../games/trix/managers/RoundManager");
const ScoreManager = require("../games/trix/managers/ScoreManager");
const Deck = require("../games/trix/models/Deck");

const ROUNDS = Math.max(1, parseInt(process.argv[2] || "400", 10));

// ── Tarneeb 41 ───────────────────────────────────────────────────────────────

function simulateTarneebRound() {
  const deck = shuffle(newDeck());
  const hands = [[], [], [], []];
  for (let i = 0; i < 52; i += 1) hands[i % 4].push(deck[i]);
  const trump = rules.oppositeColorSuit(hands[3][hands[3].length - 1].suit);

  // Declared in seat order, so the last seat sees the running total the way it
  // does at a real table.
  const bids = [null, null, null, null];
  for (let seat = 0; seat < 4; seat += 1) {
    bids[seat] = TarneebBot.botBid(hands[seat], trump, null, { seat, declaredBids: bids });
  }
  const taken = [0, 0, 0, 0];
  const played = [];
  let leader = 0;

  for (let trickNo = 0; trickNo < 13; trickNo += 1) {
    const trick = [];
    let ledSuit = null;
    for (let i = 0; i < 4; i += 1) {
      const seat = (leader + i) % 4;
      const ctx = {
        seat,
        trick,
        trump,
        declaredBids: bids,
        tricksTaken: taken,
        playedCards: played,
      };
      const card = TarneebBot.pickAutoPlayCard(hands[seat], ledSuit, rules, null, ctx);
      if (!card) throw new Error(`seat ${seat} returned no card`);

      // Legality — the whole point of the probe.
      const legal = rules.getValidCards(hands[seat], ledSuit);
      if (!legal.some((c) => c.suit === card.suit && c.rank === card.rank)) {
        throw new Error(
          `ILLEGAL: seat ${seat} played ${card.rank}${card.suit} on led ${ledSuit}`,
        );
      }

      const at = hands[seat].findIndex((c) => c.suit === card.suit && c.rank === card.rank);
      hands[seat].splice(at, 1);
      trick.push({ card, playerIndex: seat });
      played.push({ suit: card.suit, rank: card.rank });
      if (i === 0) ledSuit = card.suit;
    }
    const winner = rules.winningCardInTrick(trick, ledSuit, trump);
    taken[winner.playerIndex] += 1;
    leader = winner.playerIndex;
  }

  return { bids, taken };
}

function runTarneeb(rounds) {
  let declared = 0;
  let made = 0;
  let passes = 0;
  let overshoot = 0;
  let bidPoints = 0;
  let bidTotal = 0;
  let redeals = 0;

  for (let r = 0; r < rounds; r += 1) {
    const { bids, taken } = simulateTarneebRound();
    // Syrian 41 redeals whenever the four declarations add up to less than 11,
    // so a bot table that bids too honestly never gets a hand played at all.
    if (bids.reduce((a, b) => a + b, 0) < rules.SUM_MIN_TO_PLAY) redeals += 1;
    for (let s = 0; s < 4; s += 1) {
      if (bids[s] === 0) {
        passes += 1;
        continue;
      }
      declared += 1;
      bidTotal += bids[s];
      if (taken[s] >= bids[s]) {
        made += 1;
        bidPoints += bids[s];
      } else {
        bidPoints -= bids[s];
      }
      overshoot += taken[s] - bids[s];
    }
  }

  return {
    declared,
    passes,
    madeRate: declared ? made / declared : 0,
    avgOvershoot: declared ? overshoot / declared : 0,
    avgBid: declared ? bidTotal / declared : 0,
    redealRate: redeals / rounds,
    // Points the bidder scores on its own declarations: +bid made, -bid failed.
    // The metric the bid level is actually tuned against.
    pointsPerRound: bidPoints / (rounds * 4),
  };
}

// ── Trix ─────────────────────────────────────────────────────────────────────

/** What shipped before: always the first/lowest legal card. */
function dumbPick(gameState, seat, valid) {
  if (gameState.currentGameType === "Trix") {
    const jacks = valid.filter((c) => c.rank === "J");
    if (jacks.length > 0) return jacks[0];
    return valid[0];
  }
  return [...valid].sort((a, b) => a.value - b.value)[0];
}

function freshTrixState() {
  const players = [0, 1, 2, 3].map(() => ({ hand: [], takenCards: [], score: 0 }));
  const deck = new Deck();
  deck.dealCardsToPlayers(players);
  return {
    players,
    currentKingIndex: 0,
    currentGameType: null,
    roundNumber: 0,
    turnPlayerIndex: 0,
    tableCards: [],
    lastTrick: [],
    leadingSuit: null,
    trixTable: {
      Spades: { min: null, max: null },
      Hearts: { min: null, max: null },
      Diamonds: { min: null, max: null },
      Clubs: { min: null, max: null },
    },
    finishedPlayers: [],
    lastPassedPlayers: [],
    gamesPlayedByKing: [[], [], [], []],
    roundPlayedCards: [],
    scores: [0, 0, 0, 0],
    roundScoreApplied: false,
    lastRoundDelta: [0, 0, 0, 0],
    scoreLog: [],
  };
}

/**
 * Play one contract. `smartSeats` is the set of seats using the new bot; the
 * rest use the old lowest-card bot, so the two are measured on the same deal.
 */
function simulateTrixContract(contract, smartSeats) {
  const gs = freshTrixState();
  RoundManager.selectGame(gs, contract);

  let guard = 0;
  while (!gs.isRoundOver?.() && guard < 400) {
    guard += 1;
    const seat = gs.turnPlayerIndex;
    const valid = GameManager.getValidCards(gs, seat);

    if (valid.length === 0) {
      if (contract === "Trix") {
        const before = gs.turnPlayerIndex;
        GameManager.nextTurn(gs);
        if (gs.turnPlayerIndex === before) break;
        continue;
      }
      break;
    }

    const card = smartSeats.has(seat)
      ? TrixBot.botChooseCard(gs, seat, valid)
      : dumbPick(gs, seat, valid);

    if (!valid.some((c) => c.rank === card.rank && c.suit === card.suit)) {
      throw new Error(`ILLEGAL: ${contract} seat ${seat} played ${card.rank}${card.suit}`);
    }

    const res = GameManager.playCard(gs, seat, card);
    if (!res.success) throw new Error(`playCard rejected: ${res.reason}`);

    if (contract === "Trix") {
      if (gs.finishedPlayers.length >= 3) break;
      GameManager.nextTurn(gs);
    } else if (gs.tableCards.length === 4) {
      GameManager.resolveTrick(gs);
      if (gs.players.every((p) => p.hand.length === 0)) break;
    } else {
      GameManager.nextTurn(gs);
    }
  }

  return ScoreManager.computeRoundScore(gs);
}

function runTrix(rounds) {
  const contracts = ["Diamonds", "Tricks", "Queens", "KingOfHearts", "Trix"];
  const out = {};

  for (const contract of contracts) {
    let smartTotal = 0;
    let dumbTotal = 0;
    // Seats 0 and 2 play the new bot, 1 and 3 the old one, on the same deal.
    const smartSeats = new Set([0, 2]);

    for (let r = 0; r < rounds; r += 1) {
      const scores = simulateTrixContract(contract, smartSeats);
      smartTotal += scores[0] + scores[2];
      dumbTotal += scores[1] + scores[3];
    }

    out[contract] = {
      smart: smartTotal / (rounds * 2),
      dumb: dumbTotal / (rounds * 2),
    };
  }

  return out;
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`Card-bot self-play — ${ROUNDS} rounds per measurement\n`);

const t = runTarneeb(ROUNDS);
console.log("Tarneeb 41");
console.log(`  bids declared     ${t.declared} (${t.passes} passes)`);
console.log(`  bid made          ${(t.madeRate * 100).toFixed(1)}%`);
console.log(`  avg tricks over   ${t.avgOvershoot.toFixed(2)}`);
console.log(`  avg bid           ${t.avgBid.toFixed(2)}`);
console.log(`  redeal rate       ${(t.redealRate * 100).toFixed(1)}%  (sum < ${rules.SUM_MIN_TO_PLAY})`);
console.log(`  own bid points/rd ${t.pointsPerRound.toFixed(2)} per seat`);

console.log("\nTrix — avg points per seat (higher is better; new bot vs old)");
const trix = runTrix(ROUNDS);
for (const [contract, row] of Object.entries(trix)) {
  const delta = row.smart - row.dumb;
  const sign = delta >= 0 ? "+" : "";
  console.log(
    `  ${contract.padEnd(13)} new ${row.smart.toFixed(1).padStart(7)}` +
      `   old ${row.dumb.toFixed(1).padStart(7)}   diff ${sign}${delta.toFixed(1)}`,
  );
}
