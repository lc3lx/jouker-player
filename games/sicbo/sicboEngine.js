/**
 * Sic Bo pure game engine — no I/O, fully deterministic and unit-testable.
 *
 * Dice are generated from a provably-fair HMAC-SHA256 RNG (games/dice/seededRng.js):
 * the same (serverSeed, clientSeed, nonce) always yields the same three dice, so a
 * player can verify a settled round after the serverSeed is revealed.
 */
const { createSeededRng } = require("../dice/seededRng");
const { oddsFor, isValidBetType } = require("./sicboConstants");

/**
 * Roll three dice deterministically from provably-fair seeds.
 * @param {string} serverSeed  secret until the round is revealed
 * @param {string} clientSeed  player/table supplied entropy
 * @param {string|number} nonce  round-unique counter
 * @returns {[number, number, number]} three dice, each 1–6
 */
function rollDice(serverSeed, clientSeed, nonce) {
  const rng = createSeededRng(serverSeed, String(clientSeed), String(nonce));
  const dice = [];
  for (let i = 0; i < 3; i += 1) {
    // rng() ∈ [0,1); map to an unbiased 1–6.
    dice.push(Math.floor(rng() * 6) + 1);
  }
  return dice;
}

/** Sum of the three dice. */
function diceTotal(dice) {
  return dice[0] + dice[1] + dice[2];
}

/** True when all three dice are equal. */
function isTriple(dice) {
  return dice[0] === dice[1] && dice[1] === dice[2];
}

/** How many of the three dice show `face` (1–6). */
function countFace(dice, face) {
  return dice.reduce((n, d) => (d === face ? n + 1 : n), 0);
}

/**
 * Evaluate a single bet against a dice result.
 * Encodes corrected standard Sic Bo rules:
 *   - big/small/odd/even LOSE on any triple.
 *   - single_N pays 1× per matching die (so a triple of N pays 3×).
 * @param {string} betType
 * @param {[number,number,number]} dice
 * @returns {{ won: boolean, multiplier: number }} multiplier = NET winnings per unit stake
 */
function evaluateBet(betType, dice) {
  const type = String(betType);
  if (!isValidBetType(type)) return { won: false, multiplier: 0 };

  const total = diceTotal(dice);
  const triple = isTriple(dice);
  const netOdds = oddsFor(type);

  // Big / Small — lose on any triple.
  if (type === "big") {
    return win(!triple && total >= 11 && total <= 17, netOdds);
  }
  if (type === "small") {
    return win(!triple && total >= 4 && total <= 10, netOdds);
  }

  // Odd / Even — lose on any triple.
  if (type === "odd") {
    return win(!triple && total % 2 === 1, netOdds);
  }
  if (type === "even") {
    return win(!triple && total % 2 === 0, netOdds);
  }

  // Total N (4–17).
  if (type.startsWith("total_")) {
    const n = parseInt(type.slice(6), 10);
    return win(total === n, netOdds);
  }

  // Specific double: at least two dice show N.
  if (type.startsWith("double_")) {
    const n = parseInt(type.slice(7), 10);
    return win(countFace(dice, n) >= 2, netOdds);
  }

  // Specific triple: all three dice show N.
  if (type.startsWith("triple_")) {
    const n = parseInt(type.slice(7), 10);
    return win(triple && dice[0] === n, netOdds);
  }

  // Any triple.
  if (type === "any_triple") {
    return win(triple, netOdds);
  }

  // Two-dice combination: both faces present.
  if (type.startsWith("combo_")) {
    const pair = type.slice(6);
    const a = parseInt(pair[0], 10);
    const b = parseInt(pair[1], 10);
    return win(dice.includes(a) && dice.includes(b), netOdds);
  }

  // Single die N — pays per matching die (1×, 2×, or 3×).
  if (type.startsWith("single_")) {
    const n = parseInt(type.slice(7), 10);
    const matches = countFace(dice, n);
    if (matches === 0) return { won: false, multiplier: 0 };
    return { won: true, multiplier: netOdds * matches };
  }

  return { won: false, multiplier: 0 };
}

function win(condition, netOdds) {
  return condition ? { won: true, multiplier: netOdds } : { won: false, multiplier: 0 };
}

/**
 * Settle a list of bets against a dice result.
 * Payout = stake returned + net winnings for winners; 0 for losers.
 * @param {Array<{betType:string, amount:number, userId?:string, betId?:string}>} bets
 * @param {[number,number,number]} dice
 * @returns {{ results: Array, totalStake: number, totalPayout: number, houseProfit: number }}
 */
function settleBets(bets, dice) {
  let totalStake = 0;
  let totalPayout = 0;
  const results = (Array.isArray(bets) ? bets : []).map((bet) => {
    const amount = Math.max(0, Math.floor(Number(bet.amount) || 0));
    const { won, multiplier } = evaluateBet(bet.betType, dice);
    // Winner receives the original stake back PLUS net winnings.
    const payout = won ? amount + Math.floor(amount * multiplier) : 0;
    totalStake += amount;
    totalPayout += payout;
    return {
      ...bet,
      amount,
      won,
      multiplier,
      payout,
      status: won ? "won" : "lost",
    };
  });
  return {
    results,
    totalStake,
    totalPayout,
    houseProfit: totalStake - totalPayout,
  };
}

/**
 * Derive the human-readable summary of a dice result (for history strip / audit).
 * @param {[number,number,number]} dice
 */
function summarize(dice) {
  const total = diceTotal(dice);
  const triple = isTriple(dice);
  return {
    dice: [...dice],
    total,
    isTriple: triple,
    // Big/Small/Odd/Even are undefined on a triple (all lose).
    bigSmall: triple ? "triple" : total >= 11 ? "big" : "small",
    oddEven: triple ? "triple" : total % 2 === 1 ? "odd" : "even",
  };
}

module.exports = {
  rollDice,
  diceTotal,
  isTriple,
  countFace,
  evaluateBet,
  settleBets,
  summarize,
};
