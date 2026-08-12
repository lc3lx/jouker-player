"use strict";

/**
 * Platform staff permission catalog for the Admin Dashboard.
 *
 * Roles on User:
 *   superadmin > admin > manager > support > user
 *
 * Superadmin has every capability implicitly.
 * Other staff use `user.permissions[]` capability keys.
 * Legacy `admin`/`manager` with empty permissions keep full module access
 * (backward compatible) until the superadmin assigns an explicit list.
 */

const ApiError = require("../utils/apiError");

const CAPABILITIES = Object.freeze({
  // Bootstrap / self
  ADMIN_ACCESS: "admin.access",

  // Staff management (superadmin)
  STAFF_READ: "staff.read",
  STAFF_WRITE: "staff.write",

  // End users
  USERS_READ: "users.read",
  USERS_WRITE: "users.write",
  USERS_BAN: "users.ban",
  USERS_WALLET: "users.wallet",

  // Support desk
  SUPPORT_READ: "support.read",
  SUPPORT_WRITE: "support.write",

  // Deposit agents
  AGENTS_READ: "agents.read",
  AGENTS_WRITE: "agents.write",
  AGENTS_WALLET: "agents.wallet",
  AGENTS_REPORTS: "agents.reports",

  // Modules
  VIP: "vip.manage",
  ECONOMY: "economy.manage",
  COSMETICS: "cosmetics.manage",
  TABLES: "tables.manage",
  BOTS: "bots.manage",
  CLANS: "clans.manage",
  REFERRALS: "referrals.manage",
  RECHARGE: "recharge.manage",
  GAMES: "games.manage",
  SETTINGS: "settings.manage",
  AUDIT: "audit.read",
  REPORTS: "reports.read",
});

const ALL = Object.freeze(Object.values(CAPABILITIES));

/** Default capability sets when creating staff without an explicit list. */
const ROLE_DEFAULTS = Object.freeze({
  superadmin: ALL.slice(),
  admin: ALL.filter((c) => c !== CAPABILITIES.STAFF_WRITE),
  manager: [
    CAPABILITIES.ADMIN_ACCESS,
    CAPABILITIES.USERS_READ,
    CAPABILITIES.USERS_WRITE,
    CAPABILITIES.USERS_BAN,
    CAPABILITIES.SUPPORT_READ,
    CAPABILITIES.SUPPORT_WRITE,
    CAPABILITIES.AGENTS_READ,
    CAPABILITIES.AGENTS_REPORTS,
    CAPABILITIES.VIP,
    CAPABILITIES.TABLES,
    CAPABILITIES.REPORTS,
    CAPABILITIES.AUDIT,
  ],
  support: [
    CAPABILITIES.ADMIN_ACCESS,
    CAPABILITIES.USERS_READ,
    CAPABILITIES.SUPPORT_READ,
    CAPABILITIES.SUPPORT_WRITE,
  ],
});

const STAFF_ROLES = Object.freeze(["superadmin", "admin", "manager", "support"]);

function isStaffRole(role) {
  return STAFF_ROLES.includes(String(role || ""));
}

function isSuperAdmin(user) {
  return user && String(user.role) === "superadmin";
}

/**
 * Resolve effective capabilities for a staff user.
 * - superadmin → all
 * - explicit permissions[] (non-empty) → that list (+ admin.access)
 * - empty permissions on admin/manager → full legacy access for their role defaults
 */
function capabilitiesFor(user) {
  if (!user || !isStaffRole(user.role)) return [];
  if (isSuperAdmin(user)) return ALL.slice();

  const explicit = Array.isArray(user.permissions)
    ? user.permissions.map(String).filter(Boolean)
    : [];
  if (explicit.includes("*")) return ALL.slice();
  if (explicit.length > 0) {
    const set = new Set(explicit);
    set.add(CAPABILITIES.ADMIN_ACCESS);
    return [...set];
  }
  return (ROLE_DEFAULTS[user.role] || []).slice();
}

function hasCapability(user, capability) {
  if (!capability) return false;
  if (isSuperAdmin(user)) return true;
  const caps = capabilitiesFor(user);
  return caps.includes("*") || caps.includes(capability);
}

function hasAnyCapability(user, capabilities) {
  return (capabilities || []).some((c) => hasCapability(user, c));
}

function requirePermission(...capabilities) {
  const needed = capabilities.filter(Boolean);
  return (req, res, next) => {
    if (!req.user) return next(new ApiError("Unauthorized", 401));
    if (needed.length === 0) return next();
    if (hasAnyCapability(req.user, needed)) return next();
    return next(
      new ApiError(
        `Permission denied: requires ${needed.join(" | ")}`,
        403
      )
    );
  };
}

/** Catalog payload for the Admin Dashboard permission matrix UI. */
function permissionsCatalog() {
  const groups = [
    {
      key: "staff",
      labelAr: "طاقم الإدارة",
      capabilities: [CAPABILITIES.STAFF_READ, CAPABILITIES.STAFF_WRITE],
    },
    {
      key: "users",
      labelAr: "المستخدمون",
      capabilities: [
        CAPABILITIES.USERS_READ,
        CAPABILITIES.USERS_WRITE,
        CAPABILITIES.USERS_BAN,
        CAPABILITIES.USERS_WALLET,
      ],
    },
    {
      key: "support",
      labelAr: "الدعم الفني",
      capabilities: [CAPABILITIES.SUPPORT_READ, CAPABILITIES.SUPPORT_WRITE],
    },
    {
      key: "agents",
      labelAr: "الوكلاء",
      capabilities: [
        CAPABILITIES.AGENTS_READ,
        CAPABILITIES.AGENTS_WRITE,
        CAPABILITIES.AGENTS_WALLET,
        CAPABILITIES.AGENTS_REPORTS,
      ],
    },
    {
      key: "modules",
      labelAr: "وحدات التطبيق",
      capabilities: [
        CAPABILITIES.VIP,
        CAPABILITIES.ECONOMY,
        CAPABILITIES.COSMETICS,
        CAPABILITIES.TABLES,
        CAPABILITIES.BOTS,
        CAPABILITIES.CLANS,
        CAPABILITIES.REFERRALS,
        CAPABILITIES.RECHARGE,
        CAPABILITIES.GAMES,
        CAPABILITIES.SETTINGS,
        CAPABILITIES.AUDIT,
        CAPABILITIES.REPORTS,
      ],
    },
  ];
  return {
    capabilities: ALL.slice(),
    labels: {
      [CAPABILITIES.ADMIN_ACCESS]: "دخول لوحة الإدارة",
      [CAPABILITIES.STAFF_READ]: "عرض طاقم الإدارة",
      [CAPABILITIES.STAFF_WRITE]: "إدارة صلاحيات الطاقم",
      [CAPABILITIES.USERS_READ]: "عرض المستخدمين",
      [CAPABILITIES.USERS_WRITE]: "تعديل المستخدمين",
      [CAPABILITIES.USERS_BAN]: "حظر / كتم",
      [CAPABILITIES.USERS_WALLET]: "تعديل محفظة لاعب",
      [CAPABILITIES.SUPPORT_READ]: "عرض تذاكر الدعم",
      [CAPABILITIES.SUPPORT_WRITE]: "الرد / إغلاق تذاكر الدعم",
      [CAPABILITIES.AGENTS_READ]: "عرض الوكلاء",
      [CAPABILITIES.AGENTS_WRITE]: "إنشاء / تعديل وكلاء",
      [CAPABILITIES.AGENTS_WALLET]: "شحن / سحب محفظة وكيل",
      [CAPABILITIES.AGENTS_REPORTS]: "تقارير مبيعات الوكلاء",
      [CAPABILITIES.VIP]: "إدارة VIP",
      [CAPABILITIES.ECONOMY]: "إدارة المتجر / الاقتصاد",
      [CAPABILITIES.COSMETICS]: "إدارة المظاهر",
      [CAPABILITIES.TABLES]: "إدارة الطاولات",
      [CAPABILITIES.BOTS]: "إدارة البوتات",
      [CAPABILITIES.CLANS]: "إدارة العشائر",
      [CAPABILITIES.REFERRALS]: "إدارة الإحالات",
      [CAPABILITIES.RECHARGE]: "أكواد الشحن",
      [CAPABILITIES.GAMES]: "إدارة الألعاب",
      [CAPABILITIES.SETTINGS]: "إعدادات النظام",
      [CAPABILITIES.AUDIT]: "سجلات التدقيق",
      [CAPABILITIES.REPORTS]: "التقارير",
    },
    roleDefaults: ROLE_DEFAULTS,
    staffRoles: STAFF_ROLES.slice(),
    groups,
  };
}

function sanitizePermissions(list) {
  if (!Array.isArray(list)) return [];
  const allowed = new Set(ALL);
  const out = [];
  for (const raw of list) {
    const key = String(raw || "").trim();
    if (key === "*") return ALL.slice();
    if (allowed.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

module.exports = {
  CAPABILITIES,
  ALL,
  ROLE_DEFAULTS,
  STAFF_ROLES,
  isStaffRole,
  isSuperAdmin,
  capabilitiesFor,
  hasCapability,
  hasAnyCapability,
  requirePermission,
  permissionsCatalog,
  sanitizePermissions,
};
