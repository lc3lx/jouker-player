/**
 * How the agent list is ordered for a player choosing who to deposit with.
 *
 * This used to be `sort((a, b) => Number(b.online) - Number(a.online))` and
 * nothing else, so past the online/offline split the order was whatever Mongo
 * happened to return — a brand new agent could sit above one with a thousand
 * completed deposits and a five-star record.
 *
 * Pure and exported on its own so the ordering can be tested without a
 * database, and so the rule lives somewhere a person can read it.
 */

/** An agent with no ratings yet is neither endorsed nor punished. */
const UNRATED = 0;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The rating an agent is ranked by.
 *
 * An agent with one five-star review is not better than one with two hundred
 * reviews averaging 4.8, so a rating only counts once a few people have left
 * one. Below that the agent ranks on volume alone, which is the honest signal
 * for someone with no reviews yet.
 */
const MIN_RATINGS_TO_RANK = 3;

function rankedRating(agent) {
  const count = num(agent?.ratingCount);
  if (count < MIN_RATINGS_TO_RANK) return UNRATED;
  return num(agent?.rating);
}

/**
 * Compare two agents for the player-facing list. Sorts ascending, so a
 * negative result puts `a` first.
 *
 * Order: whoever can answer now, then whoever is trusted, then whoever is
 * proven, then whoever is quick.
 */
function compareAgents(a, b) {
  // 1. Online first. An agent who cannot answer is no use however good.
  const online = Number(!!b?.online) - Number(!!a?.online);
  if (online !== 0) return online;

  // 2. Better rated, once enough people have rated them.
  const rating = rankedRating(b) - rankedRating(a);
  if (rating !== 0) return rating;

  // 3. More completed deposits — the record that is hard to fake.
  const deposits = num(b?.totalDeposits) - num(a?.totalDeposits);
  if (deposits !== 0) return deposits;

  // 4. Faster to reply. Zero means "never measured", which must not beat a
  //    real, fast time — it sorts last among agents otherwise equal.
  const aResp = num(a?.avgResponseMinutes);
  const bResp = num(b?.avgResponseMinutes);
  if (aResp !== bResp) {
    if (aResp === 0) return 1;
    if (bResp === 0) return -1;
    return aResp - bResp;
  }

  // 5. Stable, so the list does not reshuffle between identical agents.
  return String(a?.agentProfileId || "").localeCompare(
    String(b?.agentProfileId || "")
  );
}

/** A new copy of `agents`, ordered for the player-facing list. */
function rankAgents(agents) {
  if (!Array.isArray(agents)) return [];
  return [...agents].sort(compareAgents);
}

/**
 * Fold a new response time into an agent's running average.
 *
 * A plain mean over all history stops moving after a few hundred tickets, so a
 * agent who got slow would keep an old fast number. This weights recent
 * tickets more heavily while still being cheap to store — one number.
 *
 * @param {number} current existing average in minutes, 0 when never measured
 * @param {number} sampleMinutes the ticket just measured
 * @returns {number} the new average, rounded to one decimal
 */
function foldResponseTime(current, sampleMinutes) {
  const sample = num(sampleMinutes, -1);
  if (sample < 0) return num(current);
  const prev = num(current);
  // First measurement: adopt it outright rather than averaging against zero,
  // which would report half the real time.
  if (prev <= 0) return Math.round(sample * 10) / 10;
  const next = prev * 0.8 + sample * 0.2;
  return Math.round(next * 10) / 10;
}

module.exports = {
  MIN_RATINGS_TO_RANK,
  compareAgents,
  rankAgents,
  foldResponseTime,
};
