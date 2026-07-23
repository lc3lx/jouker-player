/**
 * Clan system shared constants.
 *
 * Roles, permission keys and the DEFAULT permission matrix live here so both the
 * Mongoose models (enum sources) and the services (permission checks) reference a
 * single source of truth. Admin-tunable numeric defaults (creation cost, limits)
 * seed the ClanSettings singleton — see models/clanSettingsModel.js.
 */

/** Ordered low→high; higher rank = more authority. Used to prevent self-elevation. */
const ROLES = ["member", "elder", "officer", "coleader", "leader", "owner"];

const ROLE_RANK = {
  member: 10,
  elder: 20,
  officer: 40,
  coleader: 60,
  leader: 80,
  owner: 100,
};

/** Every guardable clan action. Extend here + grant in DEFAULT_ROLE_PERMISSIONS. */
const PERMISSION_KEYS = [
  "invite",
  "kick",
  "acceptRequests",
  "rejectRequests",
  "manageChat",
  "createTournaments",
  "createAnnouncements",
  "editClan",
  "manageRoles",
  "manageTreasury",
  "createEvents",
  "banMembers",
];

/**
 * Default grants per role, as { role: [permissionKey, ...] }. Owner is implicitly
 * all-powerful (never consulted). A clan may override this via Clan.rolePermissions
 * (same shape); missing roles fall back to these defaults.
 */
const DEFAULT_ROLE_PERMISSIONS = {
  owner: [...PERMISSION_KEYS],
  leader: [...PERMISSION_KEYS],
  coleader: [
    "invite",
    "kick",
    "acceptRequests",
    "rejectRequests",
    "manageChat",
    "createTournaments",
    "createAnnouncements",
    "createEvents",
    "manageTreasury",
  ],
  officer: ["invite", "acceptRequests", "rejectRequests", "manageChat", "createEvents"],
  elder: ["invite"],
  member: [],
};

const JOIN_TYPES = ["public", "request", "invite"];

/** Admin-tunable defaults that seed the ClanSettings singleton on first read. */
const CLAN_DEFAULTS = {
  creationCost: 10000000, // 10,000,000 coins — configurable from admin panel
  maxMembersDefault: 50,
  tagMinLen: 2,
  tagMaxLen: 6,
  maxTournamentsPerClan: 5, // concurrent active tournaments per clan
  treasuryEnabled: true,
  donationDailyLimit: 50000000,
  minDonation: 1000,
};

module.exports = {
  ROLES,
  ROLE_RANK,
  PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  JOIN_TYPES,
  CLAN_DEFAULTS,
};
