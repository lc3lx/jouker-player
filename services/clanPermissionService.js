const ApiError = require("../utils/apiError");
const {
  ROLE_RANK,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_KEYS,
} = require("../config/clanConfig");

/**
 * Resolve the effective permission set for a role in a clan.
 * Precedence: per-clan override (Clan.rolePermissions) → global default
 * (ClanSettings.defaultRolePermissions) → hardcoded config defaults.
 * `settings` is optional so callers that don't have it still get a sane result.
 */
function resolvePermissions(clan, role, settings = null) {
  if (!role) return new Set();
  const clanOverride = clan && clan.rolePermissions && clan.rolePermissions[role];
  if (Array.isArray(clanOverride)) return new Set(clanOverride);

  const settingsDefault =
    settings && settings.defaultRolePermissions && settings.defaultRolePermissions[role];
  if (Array.isArray(settingsDefault)) return new Set(settingsDefault);

  return new Set(DEFAULT_ROLE_PERMISSIONS[role] || []);
}

/** Does `role` in `clan` hold `permissionKey`? Owner implicitly holds everything. */
function can(clan, role, permissionKey, settings = null) {
  if (role === "owner") return true;
  if (!PERMISSION_KEYS.includes(permissionKey)) return false;
  return resolvePermissions(clan, role, settings).has(permissionKey);
}

function assertCan(clan, role, permissionKey, settings = null) {
  if (!can(clan, role, permissionKey, settings)) {
    throw new ApiError("You do not have permission for this action", 403);
  }
}

function rank(role) {
  return ROLE_RANK[role] || 0;
}

/** An actor may only manage (kick/promote/demote) members strictly below their rank. */
function canManageTarget(actorRole, targetRole) {
  return rank(actorRole) > rank(targetRole);
}

/** Guard: actor may assign `newRole` only if it is strictly below their own rank. */
function assertCanAssignRole(actorRole, newRole) {
  if (!ROLE_RANK[newRole]) throw new ApiError("Invalid role", 400);
  if (newRole === "owner") {
    throw new ApiError("Use transfer ownership to assign owner", 400);
  }
  if (rank(newRole) >= rank(actorRole)) {
    throw new ApiError("Cannot assign a role at or above your own", 403);
  }
}

module.exports = {
  resolvePermissions,
  can,
  assertCan,
  canManageTarget,
  assertCanAssignRole,
  rank,
};
