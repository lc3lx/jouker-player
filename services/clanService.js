const mongoose = require("mongoose");
const ApiError = require("../utils/apiError");
const Clan = require("../models/clanModel");
const ClanMember = require("../models/clanMemberModel");
const ClanSettings = require("../models/clanSettingsModel");
const User = require("../models/userModel");
const { withMongoTransaction, ledgerWithdraw } = require("./walletLedgerService");
const { JOIN_TYPES } = require("../config/clanConfig");
const clanPermissionService = require("./clanPermissionService");

// ─── settings cache (short TTL — admin edits apply within 30s) ────────────────
let _settingsCache = { value: null, at: 0 };
async function getSettings() {
  const now = Date.now();
  if (_settingsCache.value && now - _settingsCache.at < 30000) return _settingsCache.value;
  const s = await ClanSettings.getDefaults();
  _settingsCache = { value: s, at: now };
  return s;
}
function invalidateSettingsCache() {
  _settingsCache = { value: null, at: 0 };
}

// ─── validation ───────────────────────────────────────────────────────────────
function validateCreateInput(payload, settings) {
  const name = String(payload.name || "").trim();
  if (name.length < 2 || name.length > 40) {
    throw new ApiError("Clan name must be 2–40 characters", 400);
  }
  const tag = String(payload.tag || "").trim().toUpperCase();
  const tagRe = new RegExp(`^[A-Z0-9]{${settings.tagMinLen},${settings.tagMaxLen}}$`);
  if (!tagRe.test(tag)) {
    throw new ApiError(
      `Tag must be ${settings.tagMinLen}–${settings.tagMaxLen} letters/numbers`,
      400
    );
  }
  const joinType = payload.joinType && JOIN_TYPES.includes(payload.joinType)
    ? payload.joinType
    : "public";
  return {
    name,
    tag,
    description: String(payload.description || "").trim().slice(0, 500),
    country: payload.country ? String(payload.country).toUpperCase().trim() : undefined,
    language: payload.language ? String(payload.language).toLowerCase().trim() : "ar",
    logo: payload.logo || null,
    banner: payload.banner || null,
    joinType,
  };
}

// ─── serialization ──────────────────────────────────────────────────────────
function serializeSummary(clan) {
  return {
    id: String(clan._id),
    name: clan.name,
    tag: clan.tag,
    logo: clan.logo || null,
    banner: clan.banner || null,
    country: clan.country || null,
    language: clan.language || null,
    joinType: clan.joinType,
    memberCount: clan.memberCount,
    maxMembers: clan.maxMembers,
    rankScore: clan.stats?.rankScore || 0,
    level: clan.level || 1,
    status: clan.status,
  };
}

function serializeProfile(clan, viewerMembership = null) {
  return {
    ...serializeSummary(clan),
    description: clan.description || "",
    owner: clan.owner ? String(clan.owner) : null,
    createdAt: clan.createdAt,
    treasury: { balance: clan.treasury?.balance || 0 },
    stats: clan.stats || {},
    xp: clan.xp || 0,
    viewer: viewerMembership
      ? { isMember: true, role: viewerMembership.role, joinedAt: viewerMembership.joinedAt }
      : { isMember: false, role: null },
  };
}

// ─── denorm helper (kept in sync with ClanMember inside the same session) ─────
async function setUserClanDenorm(session, userId, clan, role) {
  const value = clan
    ? { id: clan._id, tag: clan.tag, role }
    : { id: null, tag: null, role: null };
  await User.updateOne({ _id: userId }, { $set: { clan: value } }, session ? { session } : {});
}

function isDuplicateKey(err) {
  return err && (err.code === 11000 || err.code === 11001);
}

// ─── create (atomic: cost deduction + clan + owner membership) ────────────────
async function createClan(userId, payload) {
  const settings = await getSettings();
  const input = validateCreateInput(payload, settings);

  // Fast pre-checks (the DB unique indexes are the real guarantee under races).
  const already = await ClanMember.findOne({ user: userId }).lean();
  if (already) throw new ApiError("You already belong to a clan", 409);
  const tagTaken = await Clan.findOne({ tag: input.tag, status: { $ne: "deleted" } }).lean();
  if (tagTaken) throw new ApiError("Clan tag already taken", 409);

  const cost = Math.max(0, Math.floor(Number(settings.creationCost) || 0));

  try {
    const clan = await withMongoTransaction(async (session) => {
      // 1) Charge creation cost — throws INSUFFICIENT_BALANCE → whole txn aborts.
      if (cost > 0) {
        await ledgerWithdraw({
          session,
          userId,
          amount: cost,
          ledgerType: "clan_create",
          meta: { source: "clan_create", tag: input.tag },
        });
      }
      // 2) Create the clan.
      const [created] = await Clan.create(
        [
          {
            ...input,
            owner: userId,
            memberCount: 1,
            maxMembers: settings.maxMembersDefault,
          },
        ],
        session ? { session } : {}
      );
      // 3) Owner membership (unique index on user enforces one-clan-per-player).
      await ClanMember.create(
        [{ clan: created._id, user: userId, role: "owner" }],
        session ? { session } : {}
      );
      // 4) Denormalize onto the user for cheap badge lookups.
      await setUserClanDenorm(session, userId, created, "owner");
      return created;
    });
    return serializeProfile(clan, { role: "owner", joinedAt: clan.createdAt });
  } catch (err) {
    if (err && err.message === "INSUFFICIENT_BALANCE") {
      throw new ApiError("Insufficient coins to create a clan", 402);
    }
    if (isDuplicateKey(err)) {
      const dup = err.keyPattern || {};
      if (dup.user) throw new ApiError("You already belong to a clan", 409);
      if (dup.tag) throw new ApiError("Clan tag already taken", 409);
      throw new ApiError("Clan already exists", 409);
    }
    throw err;
  }
}

// ─── read ─────────────────────────────────────────────────────────────────────
async function getClanProfile(clanId, viewerUserId = null) {
  if (!mongoose.isValidObjectId(clanId)) throw new ApiError("Clan not found", 404);
  const clan = await Clan.findById(clanId);
  if (!clan || clan.status === "deleted") throw new ApiError("Clan not found", 404);

  let viewerMembership = null;
  if (viewerUserId) {
    const m = await ClanMember.findOne({ clan: clanId, user: viewerUserId }).lean();
    if (m) viewerMembership = { role: m.role, joinedAt: m.joinedAt };
  }
  return serializeProfile(clan, viewerMembership);
}

async function browseClans({ q, country, language, joinType, page = 1, limit = 20 } = {}) {
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const filter = { status: "active" };
  if (country) filter.country = String(country).toUpperCase();
  if (language) filter.language = String(language).toLowerCase();
  if (joinType && JOIN_TYPES.includes(joinType)) filter.joinType = joinType;
  if (q && String(q).trim().length >= 1) {
    const safe = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { name: { $regex: safe, $options: "i" } },
      { tag: { $regex: safe, $options: "i" } },
    ];
  }
  const [rows, total] = await Promise.all([
    Clan.find(filter)
      .sort({ "stats.rankScore": -1, memberCount: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean(),
    Clan.countDocuments(filter),
  ]);
  return { total, page: pg, limit: lim, data: rows.map(serializeSummary) };
}

// ─── edit ───────────────────────────────────────────────────────────────────
const EDITABLE_FIELDS = ["description", "logo", "banner", "country", "language", "joinType"];

async function editClan(userId, clanId, patch = {}) {
  const clan = await Clan.findById(clanId);
  if (!clan || clan.status === "deleted") throw new ApiError("Clan not found", 404);
  const member = await ClanMember.findOne({ clan: clanId, user: userId }).lean();
  if (!member) throw new ApiError("You are not a member of this clan", 403);
  const settings = await getSettings();
  clanPermissionService.assertCan(clan, member.role, "editClan", settings);

  for (const field of EDITABLE_FIELDS) {
    if (typeof patch[field] === "undefined") continue;
    if (field === "joinType") {
      if (!JOIN_TYPES.includes(patch.joinType)) throw new ApiError("Invalid join type", 400);
      clan.joinType = patch.joinType;
    } else if (field === "description") {
      clan.description = String(patch.description || "").trim().slice(0, 500);
    } else if (field === "country") {
      clan.country = patch.country ? String(patch.country).toUpperCase().trim() : undefined;
    } else if (field === "language") {
      clan.language = String(patch.language || "ar").toLowerCase().trim();
    } else {
      clan[field] = patch[field] || null;
    }
  }
  await clan.save();
  return serializeProfile(clan, { role: member.role, joinedAt: member.joinedAt });
}

module.exports = {
  getSettings,
  invalidateSettingsCache,
  createClan,
  getClanProfile,
  browseClans,
  editClan,
  serializeSummary,
  serializeProfile,
  setUserClanDenorm,
  isDuplicateKey,
};
