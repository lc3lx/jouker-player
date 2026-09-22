"use strict";

const User = require("../models/userModel");

function normalizeEmail(raw) {
  return String(raw || "")
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Resolve an existing player for admin/agent tools.
 * Exact email first, then trimmed/case-insensitive, then a unique
 * partial email / name / player-number match.
 */
async function findRegisteredUser({ userId, email, playerId } = {}) {
  if (userId) {
    const byId = await User.findById(userId);
    if (byId) return byId;
  }

  const pid = playerId != null && playerId !== "" ? Number(playerId) : null;
  if (Number.isInteger(pid) && pid > 0) {
    const byPid = await User.findOne({ playerId: pid });
    if (byPid) return byPid;
  }

  const raw = normalizeEmail(email);
  if (!raw) return null;

  const exact = await User.findOne({ email: raw });
  if (exact) return exact;

  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const spaced = await User.findOne({
    email: new RegExp(`^\\s*${escaped}\\s*$`, "i"),
  });
  if (spaced) return spaced;

  if (raw.length >= 3) {
    const or = [
      { email: new RegExp(escaped, "i") },
      { name: new RegExp(`^${escaped}$`, "i") },
    ];
    if (/^\d{1,9}$/.test(raw)) or.push({ playerId: Number(raw) });
    const matches = await User.find({ $or: or, isBot: { $ne: true } }).limit(5);
    if (matches.length === 1) return matches[0];
  }

  return null;
}

module.exports = { normalizeEmail, findRegisteredUser };
