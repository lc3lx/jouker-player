"use strict";

const { v4: uuidv4 } = require("uuid");
const User = require("../../../models/userModel");
const AgentProfile = require("../../../models/agentProfileModel");
const ReferralInviteeSnapshot = require("../models/referralInviteeSnapshotModel");
const referralProgressService = require("./referralProgressService");
const referralAuditService = require("./referralAuditService");
const { publish } = require("../../../domain/events/domainEventBus");
const Events = require("../../../domain/events/eventTypes");

function generateInviteCode() {
  return uuidv4().slice(0, 8).replace(/-/g, "").toUpperCase();
}

async function ensureInviteCode(userId) {
  const user = await User.findById(userId).select("inviteCode");
  if (!user) return null;
  if (user.inviteCode) return user.inviteCode;
  let code;
  for (let i = 0; i < 8; i++) {
    code = generateInviteCode();
    const exists = await User.exists({ inviteCode: code });
    if (!exists) break;
  }
  await User.findByIdAndUpdate(userId, { inviteCode: code });
  return code;
}

async function resolveInviteCode(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { ok: false, reason: "empty" };

  const inviter = await User.findOne({ inviteCode: code }).select("name _id active");
  if (inviter && inviter.active !== false) {
    return { ok: true, referrerId: inviter._id, referrerName: inviter.name, source: "user" };
  }

  const agent = await AgentProfile.findOne({ referralCode: code, status: "approved" }).populate(
    "user",
    "name active"
  );
  if (agent?.user && agent.user.active !== false) {
    return {
      ok: true,
      referrerId: agent.user._id,
      referrerName: agent.user.name,
      source: "agent",
    };
  }

  return { ok: false, reason: "invalid" };
}

async function linkReferralOnSignup(newUserId, code, meta = {}) {
  const resolved = await resolveInviteCode(code);
  if (!resolved.ok) return null;
  if (String(resolved.referrerId) === String(newUserId)) return null;

  const existingUser = await User.findById(newUserId).select("referredBy").lean();
  if (
    existingUser?.referredBy &&
    String(existingUser.referredBy) === String(resolved.referrerId)
  ) {
    return resolved;
  }

  await User.findByIdAndUpdate(newUserId, {
    referredBy: resolved.referrerId,
    referralMeta: {
      linkedAt: new Date(),
      source: resolved.source,
      deviceFingerprint: meta.deviceFingerprint || null,
      appInstanceId: meta.appInstanceId || null,
      registrationIp: meta.registrationIp || null,
    },
  });

  await ReferralInviteeSnapshot.findOneAndUpdate(
    { referrerId: resolved.referrerId, inviteeId: newUserId },
    {
      $setOnInsert: {
        referrerId: resolved.referrerId,
        inviteeId: newUserId,
        registeredAt: new Date(),
        qualifiedTiers: [],
      },
    },
    { upsert: true }
  );

  await referralProgressService.ensureProgress(resolved.referrerId);

  void referralAuditService.append({
    action: "invitation_linked",
    referrerId: resolved.referrerId,
    inviteeId: newUserId,
    meta: { source: resolved.source, code },
  });

  publish(Events.REFERRAL_LINKED, {
    referrerId: String(resolved.referrerId),
    inviteeId: String(newUserId),
    source: resolved.source,
  });

  return resolved;
}

module.exports = {
  generateInviteCode,
  ensureInviteCode,
  resolveInviteCode,
  linkReferralOnSignup,
};
