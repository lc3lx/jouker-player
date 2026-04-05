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

module.exports = {
  appMode,
  isProduction,
  limits,
  dailyBonusBaseChips,
};
