"use strict";

/**
 * Platform staff / permissions / admin bootstrap.
 * Mounted at /api/v1/admin (before generic catch-all handlers that need it).
 */
const express = require("express");
const authService = require("../services/authService");
const svc = require("../services/staffAdminService");
const { CAPABILITIES } = require("../services/platformPermissions");

const router = express.Router();

router.use(authService.protect);

// Any staff can hit /me and platform overview (capability-checked inside).
router.get("/me", authService.allowedTo("superadmin", "admin", "manager", "support"), svc.adminMe);
router.get(
  "/platform/overview",
  authService.allowedTo("superadmin", "admin", "manager", "support"),
  svc.adminPlatformOverview
);

// Permission catalog + staff CRUD — superadmin (or staff.write)
router.get(
  "/permissions-catalog",
  authService.allowedTo("superadmin", "admin"),
  authService.requirePermission(CAPABILITIES.STAFF_WRITE),
  svc.adminPermissionsCatalog
);

router.get(
  "/staff",
  authService.allowedTo("superadmin", "admin"),
  authService.requirePermission(CAPABILITIES.STAFF_READ, CAPABILITIES.STAFF_WRITE),
  svc.adminListStaff
);
router.post(
  "/staff",
  authService.allowedTo("superadmin", "admin"),
  authService.requirePermission(CAPABILITIES.STAFF_WRITE),
  svc.adminCreateStaff
);
router.post(
  "/staff/promote",
  authService.allowedTo("superadmin", "admin"),
  authService.requirePermission(CAPABILITIES.STAFF_WRITE),
  svc.adminPromoteUser
);
router.get(
  "/staff/:id",
  authService.allowedTo("superadmin", "admin"),
  authService.requirePermission(CAPABILITIES.STAFF_READ, CAPABILITIES.STAFF_WRITE),
  svc.adminGetStaff
);
router.put(
  "/staff/:id",
  authService.allowedTo("superadmin", "admin"),
  authService.requirePermission(CAPABILITIES.STAFF_WRITE),
  svc.adminUpdateStaff
);
router.patch(
  "/staff/:id/permissions",
  authService.allowedTo("superadmin", "admin"),
  authService.requirePermission(CAPABILITIES.STAFF_WRITE),
  svc.adminSetStaffPermissions
);
router.post(
  "/staff/:id/reset-password",
  authService.allowedTo("superadmin", "admin"),
  authService.requirePermission(CAPABILITIES.STAFF_WRITE),
  svc.adminResetStaffPassword
);

module.exports = router;
