"use strict";

const AUTO_APPROVE_MAX_RISK = Math.max(
  0,
  parseInt(process.env.REFERRAL_AUTO_APPROVE_MAX_RISK || "30", 10) || 30
);
const SUSPEND_MIN_RISK = Math.max(
  0,
  parseInt(process.env.REFERRAL_SUSPEND_MIN_RISK || "61", 10) || 61
);
const MANUAL_REVIEW_MIN_RISK = Math.max(
  0,
  parseInt(process.env.REFERRAL_MANUAL_REVIEW_MIN_RISK || "81", 10) || 81
);

const SIGNAL_WEIGHTS = {
  repeated_registrations_same_fingerprint: 15,
  same_referrer_similar_devices: 20,
  very_fast_level_progression: 15,
  fast_reward_claim_after_signup: 10,
  vpn_or_proxy_hint: 10,
  emulator_or_rooted: 10,
  shared_payment_method: 25,
  repeated_invites_same_network: 10,
  multiple_accounts_same_referrer: 12,
};

function riskBand(score) {
  if (score <= 30) return "safe";
  if (score <= 60) return "medium";
  if (score <= 80) return "high";
  return "manual_review";
}

module.exports = {
  AUTO_APPROVE_MAX_RISK,
  SUSPEND_MIN_RISK,
  MANUAL_REVIEW_MIN_RISK,
  SIGNAL_WEIGHTS,
  riskBand,
};
