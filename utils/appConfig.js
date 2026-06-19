/**
 * Launch mode: beta vs production (limits, bonuses, fraud strictness).
 */
function appMode() {
  const m = String(process.env.APP_MODE || "beta").toLowerCase();
  return m === "production" ? "production" : "beta";
}

function isProduction() {
  return appMode() === "production";
}

function limits() {
  const prod = isProduction();
  return {
    maxDepositPerDay: parseInt(
      process.env.FRAUD_MAX_DEPOSIT_DAY || (prod ? "5000" : "50000"),
      10
    ),
    maxWithdrawPerDay: parseInt(
      process.env.FRAUD_MAX_WITHDRAW_DAY || (prod ? "5000" : "50000"),
      10
    ),
    maxBonusClaimsPerDay: parseInt(
      process.env.FRAUD_MAX_BONUS_DAY || (prod ? "1" : "3"),
      10
    ),
    joinLeaveWindowMs: parseInt(process.env.FRAUD_JOIN_LEAVE_WINDOW_MS || "600000", 10),
    joinLeaveMaxEvents: parseInt(process.env.FRAUD_JOIN_LEAVE_MAX || "25", 10),
  };
}

function dailyBonusBaseChips() {
  const base = parseInt(process.env.DAILY_BONUS_CHIPS || "2500", 10);
  if (!isProduction()) {
    return Math.floor(base * parseFloat(process.env.BETA_BONUS_MULTIPLIER || "1.5"));
  }
  return base;
}

/** Chips credited per 1 USD (for display + package pricing). */
function chipsPerUsd() {
  return parseInt(process.env.CHIPS_PER_USD || "10000", 10);
}

/** Store packages shown on wallet top-up screen. */
function chipPackages() {
  const rate = chipsPerUsd();
  return [
    { id: "pkg_10k", chips: rate * 1, priceUsd: 0.99, bonusPercent: 0 },
    { id: "pkg_25k", chips: Math.round(rate * 2.5), priceUsd: 2.49, bonusPercent: 0, badge: "popular" },
    { id: "pkg_50k", chips: rate * 5, priceUsd: 4.99, bonusPercent: 10, badge: "bonus_10" },
    { id: "pkg_75k", chips: Math.round(rate * 7.5), priceUsd: 6.99, bonusPercent: 15, badge: "bonus_15" },
    { id: "pkg_100k", chips: rate * 10, priceUsd: 9.99, bonusPercent: 0 },
    { id: "pkg_150k", chips: Math.round(rate * 15), priceUsd: 14.99, bonusPercent: 20, badge: "bonus_20" },
    { id: "pkg_200k", chips: rate * 20, priceUsd: 19.99, bonusPercent: 0 },
    { id: "pkg_300k", chips: rate * 30, priceUsd: 29.99, bonusPercent: 25, badge: "popular" },
    { id: "pkg_500k", chips: rate * 50, priceUsd: 49.99, bonusPercent: 10, badge: "bonus_10" },
    { id: "pkg_1m", chips: rate * 100, priceUsd: 99.99, bonusPercent: 0 },
  ];
}

module.exports = {
  appMode,
  isProduction,
  limits,
  dailyBonusBaseChips,
  chipsPerUsd,
  chipPackages,
};
