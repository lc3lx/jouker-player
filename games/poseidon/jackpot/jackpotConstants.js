/**
 * Poseidon Jackpot — constants.
 *
 * Trigger: 3+ "jackpot" symbols on the final matrix open a Jackpot Round.
 *
 * Prize (match-3): the board is always 3× super10m + 3× mega50m + 3× grand100m.
 * The player reveals cards one-by-one; the first type to reach 3 matches wins
 * that tier's amount. There is no predetermined prize and no "no_win" filler.
 */

/** Cell id emitted by the spin engine for the jackpot scatter symbol. */
const JACKPOT_SYMBOL = "jackpot";

/**
 * QA FLAG — keep false in production.
 * When true: every spin opens a Jackpot Round (ignores scatter count).
 */
const JACKPOT_FORCE_EVERY_SPIN = false;

/**
 * Minimum jackpot scatter symbols on the FINAL matrix (post-cascade) that
 * trigger a Jackpot Round. Must NOT conflict with TRIGGER_NATURAL_MIN (which
 * counts multiplier plaques, not jackpot symbols).
 */
const JACKPOT_MIN_SYMBOLS = 3;

/**
 * Weighted prize pool selected server-side after a trigger.
 * Weights are relative (not probabilities) — the selector normalises them.
 * "no_win" means the scratch card reveals no matching prize.
 */
const JACKPOT_PRIZES = Object.freeze([
  { type: "no_win",   amount: 0,           weight: 300 },
  { type: "super10m", amount: 10_000_000,  weight: 60  },
  { type: "mega50m",  amount: 50_000_000,  weight: 30  },
  { type: "grand100m",amount: 100_000_000, weight: 10  },
]);

/** QA prize pool used while JACKPOT_FORCE_EVERY_SPIN is on — always a real win. */
const JACKPOT_PRIZES_QA = Object.freeze([
  { type: "super10m", amount: 10_000_000,  weight: 50 },
  { type: "mega50m",  amount: 50_000_000,  weight: 30 },
  { type: "grand100m",amount: 100_000_000, weight: 20 },
]);

/** Number of cards displayed on the scratch grid. */
const JACKPOT_CARD_COUNT = 9;

/**
 * Jackpot Round lifecycle statuses.
 * pending       — created, not yet revealed
 * scratching    — client has started revealing cards
 * revealed      — all cards flipped, settlement not yet requested
 * settled       — wallet credited, immutable
 * expired       — TTL exceeded without settlement (no wallet credit)
 */
const JACKPOT_STATUS = Object.freeze({
  PENDING:    "pending",
  SCRATCHING: "scratching",
  REVEALED:   "revealed",
  SETTLED:    "settled",
  EXPIRED:    "expired",
});

/** Round TTL in milliseconds — if not settled within this window, expire. */
const JACKPOT_ROUND_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Weight of the jackpot scatter in the base-game reel tables. */
const JACKPOT_BASE_WEIGHT = 0.25;

/** Weight of the jackpot scatter during free spins (richer to excite). */
const JACKPOT_BONUS_WEIGHT = 0.25;

module.exports = {
  JACKPOT_SYMBOL,
  JACKPOT_FORCE_EVERY_SPIN,
  JACKPOT_MIN_SYMBOLS,
  JACKPOT_PRIZES,
  JACKPOT_PRIZES_QA,
  JACKPOT_CARD_COUNT,
  JACKPOT_STATUS,
  JACKPOT_ROUND_TTL_MS,
  JACKPOT_BASE_WEIGHT,
  JACKPOT_BONUS_WEIGHT,
};
