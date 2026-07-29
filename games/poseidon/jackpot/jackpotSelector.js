/**
 * jackpotSelector — single responsibility: weighted prize selection.
 *
 * Uses server-side CSPRNG (crypto module). The RNG is injectable for
 * deterministic testing. Never exposes RNG details to callers.
 */

const crypto = require("crypto");
const { JACKPOT_PRIZES, JACKPOT_CARD_COUNT } = require("./jackpotConstants");

/**
 * Generate a float in [0, 1) using Node's CSPRNG.
 * @returns {number}
 */
function defaultRng() {
  return crypto.randomInt(0, 2 ** 32) / 2 ** 32;
}

/**
 * Pick a prize from a weighted array.
 *
 * @param {ReadonlyArray<{type:string,amount:number,weight:number}>} prizes
 * @param {() => number} [rng]  — injectable for tests; defaults to CSPRNG
 * @returns {{type:string,amount:number}}
 * @throws if prizes is empty or all weights are zero/negative
 */
function pickWeightedPrize(prizes = JACKPOT_PRIZES, rng = defaultRng) {
  if (!Array.isArray(prizes) || prizes.length === 0) {
    throw new Error("jackpotSelector: prizes array must not be empty");
  }

  const total = prizes.reduce((sum, p) => {
    const w = typeof p.weight === "number" && p.weight > 0 ? p.weight : 0;
    return sum + w;
  }, 0);

  if (total <= 0) {
    throw new Error("jackpotSelector: all weights are zero or negative");
  }

  let roll = rng() * total;
  for (const prize of prizes) {
    const w = typeof prize.weight === "number" && prize.weight > 0 ? prize.weight : 0;
    roll -= w;
    if (roll < 0) return { type: prize.type, amount: prize.amount };
  }

  // Floating-point safety: return last entry
  const last = prizes[prizes.length - 1];
  return { type: last.type, amount: last.amount };
}

/**
 * Generate a 9-card layout for the scratch-card mini-game.
 *
 * Rules:
 *  - If prize is "no_win" → all 9 cards are "no_win" variants (no match set).
 *  - Otherwise → exactly ONE card shows the winning prize; the other 8 are
 *    non-matching prizes (mix of other types + extra no_win cards).
 *
 * The card types placed as "losers" are chosen from the non-winning prize
 * types so the grid always looks plausible (never all blank).
 *
 * @param {{type:string,amount:number}} selectedPrize
 * @param {() => number} [rng]
 * @returns {Array<{index:number,prize:string,amount:number}>}
 */
function buildCardLayout(selectedPrize, rng = defaultRng) {
  const total = JACKPOT_CARD_COUNT;
  const cards = Array.from({ length: total }, (_, i) => ({
    index: i,
    prize: "no_win",
    amount: 0,
  }));

  if (selectedPrize.type === "no_win") {
    // All blanks — still shuffle-labelled for variety
    return cards;
  }

  // Place the single winning card at a random position
  const winPos = crypto.randomInt(0, total);
  cards[winPos] = { index: winPos, prize: selectedPrize.type, amount: selectedPrize.amount };

  // Fill remaining 8 with distractors: mix of the other real prize types
  const distractorTypes = JACKPOT_PRIZES.filter(
    (p) => p.type !== selectedPrize.type && p.type !== "no_win"
  );

  for (let i = 0; i < total; i++) {
    if (i === winPos) continue;
    // 40 % chance to show a real (non-winning) prize type as a decoy
    if (distractorTypes.length > 0 && rng() < 0.40) {
      const d = distractorTypes[crypto.randomInt(0, distractorTypes.length)];
      cards[i] = { index: i, prize: d.type, amount: d.amount };
    }
    // otherwise stays "no_win"
  }

  return cards;
}

module.exports = { pickWeightedPrize, buildCardLayout, defaultRng };
