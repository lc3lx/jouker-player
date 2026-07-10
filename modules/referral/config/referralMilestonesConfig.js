"use strict";

const { mergeRequirements } = require("../../qualification/config/qualificationDefaults");

/** Referral milestone tiers — requirements merged with defaultInviteeEligibility at runtime. */
const REFERRAL_MILESTONES = [
  {
    tierId: "tier_5",
    title: "ملازم مبتدئ",
    requiredQualifiedCount: 5,
    inviteeRequirements: { minLevel: 5 },
    reward: { chips: 1_000_000 },
    qualificationKey: "referral_tier_5",
  },
  {
    tierId: "tier_15",
    title: "ملازم نشيط",
    requiredQualifiedCount: 20,
    inviteeRequirements: { minLevel: 15 },
    reward: { chips: 3_000_000 },
    qualificationKey: "referral_tier_15",
  },
  {
    tierId: "tier_25_silver",
    title: "ملازم فضي",
    requiredQualifiedCount: 35,
    inviteeRequirements: { minLevel: 25 },
    reward: { chips: 5_000_000, vipLevel: "silver", vipDays: 7 },
    qualificationKey: "referral_tier_25",
  },
  {
    tierId: "tier_25_gold",
    title: "ملازم ذهبي",
    requiredQualifiedCount: 45,
    inviteeRequirements: { minLevel: 25, minXp: 62500, minHandsPlayed: 25 },
    reward: { chips: 7_000_000, vipLevel: "gold", vipDays: 7 },
    qualificationKey: "referral_tier_25_gold",
  },
  {
    tierId: "tier_30_platinum",
    title: "ملازم بلاتيني",
    requiredQualifiedCount: 70,
    inviteeRequirements: { minLevel: 30 },
    reward: { chips: 10_000_000, vipLevel: "platinum", vipDays: 7 },
    qualificationKey: "referral_tier_30",
  },
];

function getMilestone(tierId) {
  return REFERRAL_MILESTONES.find((m) => m.tierId === tierId) || null;
}

function requirementsForMilestone(milestone) {
  return mergeRequirements(milestone?.inviteeRequirements || {});
}

function countKeyForMilestone(milestone) {
  return milestone?.tierId || "unknown";
}

module.exports = {
  REFERRAL_MILESTONES,
  getMilestone,
  requirementsForMilestone,
  countKeyForMilestone,
};
