"use strict";

/**
 * Economy CMS permission matrix — role-expansion ready.
 *
 * The platform auth today only issues `admin` / `manager` / `user` roles, but
 * the Admin Dashboard will eventually want finer economy roles. This module
 * defines the full capability matrix now and maps the current auth roles onto
 * it, so new economy roles can be introduced later WITHOUT touching any route:
 *
 *   - a future `user.economyRole` field (or a claims service) can set the role
 *     explicitly; if absent we fall back to mapping the platform `role`.
 *
 * Capabilities are checked per-route via `requireEconomyPermission(cap)`.
 */

const ApiError = require("../utils/apiError");

const CAPABILITIES = Object.freeze({
  VIEW: "economy.view",
  ANALYTICS: "economy.analytics",
  AUDIT: "economy.audit",
  CREATE: "economy.create",
  EDIT: "economy.edit",
  DUPLICATE: "economy.duplicate",
  BULK: "economy.bulk",
  PRICE: "economy.price",
  PUBLISH: "economy.publish", // publish / disable / restore
  ARCHIVE: "economy.archive",
  MANAGE_CURRENCY: "economy.currency",
  MANAGE_CATEGORY: "economy.category",
  MANAGE_DISCOUNT: "economy.discount",
  MANAGE_SEASON: "economy.season",
  PERMANENT_DELETE: "economy.permanent_delete",
});

const ALL = Object.values(CAPABILITIES);

const ROLE_CAPS = {
  economy_viewer: [CAPABILITIES.VIEW, CAPABILITIES.ANALYTICS, CAPABILITIES.AUDIT],
  economy_editor: [
    CAPABILITIES.VIEW, CAPABILITIES.ANALYTICS, CAPABILITIES.AUDIT,
    CAPABILITIES.CREATE, CAPABILITIES.EDIT, CAPABILITIES.DUPLICATE,
    CAPABILITIES.PRICE, CAPABILITIES.MANAGE_CATEGORY,
  ],
  economy_publisher: [
    CAPABILITIES.VIEW, CAPABILITIES.ANALYTICS, CAPABILITIES.AUDIT,
    CAPABILITIES.CREATE, CAPABILITIES.EDIT, CAPABILITIES.DUPLICATE,
    CAPABILITIES.PRICE, CAPABILITIES.MANAGE_CATEGORY, CAPABILITIES.BULK,
    CAPABILITIES.PUBLISH, CAPABILITIES.ARCHIVE,
  ],
  economy_manager: [
    CAPABILITIES.VIEW, CAPABILITIES.ANALYTICS, CAPABILITIES.AUDIT,
    CAPABILITIES.CREATE, CAPABILITIES.EDIT, CAPABILITIES.DUPLICATE,
    CAPABILITIES.PRICE, CAPABILITIES.MANAGE_CATEGORY, CAPABILITIES.BULK,
    CAPABILITIES.PUBLISH, CAPABILITIES.ARCHIVE,
    CAPABILITIES.MANAGE_CURRENCY, CAPABILITIES.MANAGE_DISCOUNT, CAPABILITIES.MANAGE_SEASON,
  ],
  super_admin: ALL.slice(),
};

/** Map today's platform auth roles onto economy roles. */
const PLATFORM_ROLE_MAP = {
  admin: "super_admin",
  manager: "economy_manager",
};

/**
 * Resolve the economy role for a user. Prefers an explicit `user.economyRole`
 * (future-proofing), else maps the platform `user.role`. Unknown → null.
 */
function resolveEconomyRole(user) {
  if (!user) return null;
  const explicit = user.economyRole && String(user.economyRole).toLowerCase();
  if (explicit && ROLE_CAPS[explicit]) return explicit;
  return PLATFORM_ROLE_MAP[user.role] || null;
}

function capabilitiesFor(user) {
  const role = resolveEconomyRole(user);
  return role ? ROLE_CAPS[role] : [];
}

function hasCapability(user, capability) {
  return capabilitiesFor(user).includes(capability);
}

/** Express middleware factory: 403 unless the user's economy role has `capability`. */
function requireEconomyPermission(capability) {
  return (req, res, next) => {
    if (hasCapability(req.user, capability)) return next();
    return next(
      new ApiError(
        `Economy permission denied: ${capability} requires a higher role`,
        403
      )
    );
  };
}

module.exports = {
  CAPABILITIES,
  ROLE_CAPS,
  PLATFORM_ROLE_MAP,
  resolveEconomyRole,
  capabilitiesFor,
  hasCapability,
  requireEconomyPermission,
};
