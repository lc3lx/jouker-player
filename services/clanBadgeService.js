const ClanMember = require("../models/clanMemberModel");
const Clan = require("../models/clanModel");

/**
 * Lightweight, model-only clan badge lookups for hot paths (seats, friends, lobby,
 * leaderboards, chat, profile). Kept dependency-free so it can be called from any
 * serializer without pulling in the heavier clan services.
 */

/** Batch: userIds → { userId: { clanId, name, tag, logo, role } } (active clans only). */
async function attachBadges(userIds = []) {
  const ids = [...new Set((userIds || []).map(String))].filter(Boolean);
  if (!ids.length) return {};
  const members = await ClanMember.find({ user: { $in: ids } })
    .select("user clan role")
    .lean();
  if (!members.length) return {};
  const clanIds = [...new Set(members.map((m) => String(m.clan)))];
  const clans = await Clan.find({ _id: { $in: clanIds }, status: "active" })
    .select("name tag logo")
    .lean();
  const clanMap = new Map(clans.map((c) => [String(c._id), c]));
  const out = {};
  for (const m of members) {
    const c = clanMap.get(String(m.clan));
    if (!c) continue;
    out[String(m.user)] = {
      clanId: String(c._id),
      name: c.name,
      tag: c.tag,
      logo: c.logo || null,
      role: m.role,
    };
  }
  return out;
}

/** Full clan block for a single user's profile (null when clanless/inactive). */
async function getClanForUser(userId) {
  const m = await ClanMember.findOne({ user: userId }).lean();
  if (!m) return null;
  const c = await Clan.findById(m.clan).select("name tag logo memberCount stats.rankScore status").lean();
  if (!c || c.status !== "active") return null;
  return {
    id: String(c._id),
    name: c.name,
    tag: c.tag,
    logo: c.logo || null,
    role: m.role,
    joinedAt: m.joinedAt,
    memberCount: c.memberCount,
    rankScore: c.stats?.rankScore || 0,
  };
}

module.exports = { attachBadges, getClanForUser };
