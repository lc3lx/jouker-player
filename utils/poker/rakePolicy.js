function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteInt(value, fallback = 0) {
  return Math.max(0, Math.floor(finiteNumber(value, fallback)));
}

function envBoolean(key, fallback) {
  const raw = process.env[key];
  if (raw == null || String(raw).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

/**
 * Resolve a documented rake policy. Root `table.rake` is preferred, while the
 * existing Rake environment values remain a backwards-compatible fallback.
 */
function resolveRakePolicy(table = {}) {
  const configured = table?.rake && typeof table.rake === "object" ? table.rake : {};
  const percent = Math.max(
    0,
    Math.min(0.2, finiteNumber(configured.percent, finiteNumber(process.env.RAKE_PERCENT, 0.05)))
  );
  const cap = finiteInt(configured.cap, finiteInt(process.env.POKER_RAKE_CAP, 0));
  const noFlopNoDrop = configured.noFlopNoDrop == null
    ? envBoolean("POKER_NO_FLOP_NO_DROP", true)
    : configured.noFlopNoDrop === true;
  return { percent, cap, noFlopNoDrop };
}

/**
 * Rake is taken only from money actually contested by at least two players.
 * A returned uncalled bet is therefore never charged rake.
 */
function calculateRake({ contestedPot, flopDealt, policy }) {
  const pot = finiteInt(contestedPot, 0);
  const activePolicy = policy || resolveRakePolicy();
  if (pot <= 0 || (activePolicy.noFlopNoDrop && !flopDealt)) return 0;
  const raw = Math.floor(pot * Math.max(0, activePolicy.percent || 0));
  const cap = finiteInt(activePolicy.cap, 0);
  return cap > 0 ? Math.min(raw, cap) : raw;
}

module.exports = { resolveRakePolicy, calculateRake };
