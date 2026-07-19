"use strict";

/**
 * Economy Content Management API (IE-10) — BACKEND ONLY.
 *
 * Production-ready REST surface for a future Admin Dashboard to manage the
 * interaction economy fully data-driven: item CRUD + lifecycle + bulk, currencies,
 * categories, discounts/flash-sales, seasons, analytics and the audit trail.
 *
 * Auth: platform `protect` + per-route economy capability checks. Today's roles
 * map admin→SuperAdmin, manager→Manager (see economyPermissions); new economy
 * roles slot in with no route changes. Coins-only — no fiat anywhere.
 */

const express = require("express");
const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const authService = require("../services/authService");
const { requireEconomyPermission, CAPABILITIES, capabilitiesFor, resolveEconomyRole } = require("../services/economyPermissions");

const catalog = require("../services/economyCatalogService");
const currencies = require("../services/economyCurrencyService");
const categories = require("../services/interactionCategoryService");
const discounts = require("../services/economyDiscountService");
const seasons = require("../services/economySeasonService");
const analytics = require("../services/economyAnalyticsService");
const economyAudit = require("../services/economyAuditService");

const router = express.Router();

// All economy admin routes require a logged-in admin/manager (or future econ role).
router.use(authService.protect, authService.allowedTo("admin", "manager"));

// Map service error codes → HTTP status; unknown errors bubble to the global handler.
function toApiError(e) {
  const msg = e?.message || "ERROR";
  if (msg === "NOT_FOUND") return new ApiError("Not found", 404);
  if (/_EXISTS$/.test(msg)) return new ApiError(msg, 409);
  if (/REQUIRED|INVALID|UNKNOWN|NO_TARGETS|NO_PRICE_FIELDS|NOT_PURCHASABLE/.test(msg)) {
    return new ApiError(msg, 400);
  }
  return e;
}

/** asyncHandler that translates known service errors into ApiErrors. */
const ctrl = (fn) =>
  asyncHandler(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (e) {
      next(toApiError(e));
    }
  });

/** Portable audit/actor + reason context passed into every mutating service call. */
function ctxOf(req) {
  return { actor: economyAudit.actorFromReq(req), reason: req.body?.reason || req.query?.reason || null };
}

const ok = (res, data, status = 200) => res.status(status).json({ status: "success", data });

// ── who am I / capabilities (dashboard bootstrap) ────────────────────────────
router.get(
  "/permissions",
  requireEconomyPermission(CAPABILITIES.VIEW),
  ctrl(async (req, res) => {
    ok(res, { role: resolveEconomyRole(req.user), capabilities: capabilitiesFor(req.user) });
  })
);

// ── CATALOG ──────────────────────────────────────────────────────────────────
router.get(
  "/catalog",
  requireEconomyPermission(CAPABILITIES.VIEW),
  ctrl(async (req, res) => ok(res, await catalog.list(req.query)))
);

router.get(
  "/catalog/:idOrKey",
  requireEconomyPermission(CAPABILITIES.VIEW),
  ctrl(async (req, res) => {
    const item = await catalog.get(req.params.idOrKey);
    if (!item) throw new Error("NOT_FOUND");
    ok(res, { item });
  })
);

router.post(
  "/catalog",
  requireEconomyPermission(CAPABILITIES.CREATE),
  ctrl(async (req, res) => ok(res, { item: await catalog.create(req.body || {}, ctxOf(req)) }, 201))
);

router.put(
  "/catalog/:idOrKey",
  requireEconomyPermission(CAPABILITIES.EDIT),
  ctrl(async (req, res) => ok(res, await catalog.update(req.params.idOrKey, req.body || {}, ctxOf(req))))
);

router.patch(
  "/catalog/:idOrKey/publish",
  requireEconomyPermission(CAPABILITIES.PUBLISH),
  ctrl(async (req, res) => ok(res, await catalog.publish(req.params.idOrKey, ctxOf(req))))
);
router.patch(
  "/catalog/:idOrKey/disable",
  requireEconomyPermission(CAPABILITIES.PUBLISH),
  ctrl(async (req, res) => ok(res, await catalog.disable(req.params.idOrKey, ctxOf(req))))
);
router.patch(
  "/catalog/:idOrKey/restore",
  requireEconomyPermission(CAPABILITIES.PUBLISH),
  ctrl(async (req, res) => ok(res, await catalog.restore(req.params.idOrKey, ctxOf(req))))
);
router.patch(
  "/catalog/:idOrKey/archive",
  requireEconomyPermission(CAPABILITIES.ARCHIVE),
  ctrl(async (req, res) => ok(res, await catalog.archive(req.params.idOrKey, ctxOf(req))))
);
router.patch(
  "/catalog/:idOrKey/duplicate",
  requireEconomyPermission(CAPABILITIES.DUPLICATE),
  ctrl(async (req, res) => ok(res, { item: await catalog.duplicate(req.params.idOrKey, ctxOf(req)) }, 201))
);

router.post(
  "/catalog/bulk",
  requireEconomyPermission(CAPABILITIES.BULK),
  ctrl(async (req, res) => {
    const { action, keys, filter, value } = req.body || {};
    ok(res, await catalog.bulk({ action, keys, filter, value }, ctxOf(req)));
  })
);

// Permanent delete — Super Admin only (hard delete; everything else is soft).
router.delete(
  "/catalog/:idOrKey",
  requireEconomyPermission(CAPABILITIES.PERMANENT_DELETE),
  ctrl(async (req, res) => ok(res, await catalog.permanentDelete(req.params.idOrKey, ctxOf(req))))
);

// ── CURRENCIES ───────────────────────────────────────────────────────────────
router.get(
  "/currencies",
  requireEconomyPermission(CAPABILITIES.VIEW),
  ctrl(async (req, res) => ok(res, { currencies: await currencies.list() }))
);
router.post(
  "/currencies",
  requireEconomyPermission(CAPABILITIES.MANAGE_CURRENCY),
  ctrl(async (req, res) => {
    const doc = await currencies.create(req.body || {});
    await economyAudit.record({ ...ctxOf(req), action: "create", entity: "currency", entityId: doc.code, after: doc });
    ok(res, { currency: doc }, 201);
  })
);
router.put(
  "/currencies/:code",
  requireEconomyPermission(CAPABILITIES.MANAGE_CURRENCY),
  ctrl(async (req, res) => {
    const r = await currencies.update(req.params.code, req.body || {});
    await economyAudit.record({ ...ctxOf(req), action: "update", entity: "currency", entityId: req.params.code, before: r.before, after: r.after });
    ok(res, r);
  })
);

// ── CATEGORIES ───────────────────────────────────────────────────────────────
router.get(
  "/categories",
  requireEconomyPermission(CAPABILITIES.VIEW),
  ctrl(async (req, res) => ok(res, { categories: await categories.list() }))
);
router.post(
  "/categories",
  requireEconomyPermission(CAPABILITIES.MANAGE_CATEGORY),
  ctrl(async (req, res) => {
    const doc = await categories.create(req.body || {});
    await economyAudit.record({ ...ctxOf(req), action: "create", entity: "category", entityId: doc.key, after: doc });
    ok(res, { category: doc }, 201);
  })
);
router.put(
  "/categories/:key",
  requireEconomyPermission(CAPABILITIES.MANAGE_CATEGORY),
  ctrl(async (req, res) => {
    const r = await categories.update(req.params.key, req.body || {});
    await economyAudit.record({ ...ctxOf(req), action: "update", entity: "category", entityId: req.params.key, before: r.before, after: r.after });
    ok(res, r);
  })
);

// ── DISCOUNTS & FLASH SALES ──────────────────────────────────────────────────
router.get(
  "/discounts",
  requireEconomyPermission(CAPABILITIES.VIEW),
  ctrl(async (req, res) => ok(res, { discounts: await discounts.list() }))
);
router.get(
  "/discounts/:id",
  requireEconomyPermission(CAPABILITIES.VIEW),
  ctrl(async (req, res) => {
    const d = await discounts.get(req.params.id);
    if (!d) throw new Error("NOT_FOUND");
    ok(res, { discount: d });
  })
);
router.post(
  "/discounts",
  requireEconomyPermission(CAPABILITIES.MANAGE_DISCOUNT),
  ctrl(async (req, res) => {
    const doc = await discounts.create(req.body || {});
    await economyAudit.record({ ...ctxOf(req), action: "create", entity: "discount", entityId: String(doc._id), after: doc });
    ok(res, { discount: doc }, 201);
  })
);
router.put(
  "/discounts/:id",
  requireEconomyPermission(CAPABILITIES.MANAGE_DISCOUNT),
  ctrl(async (req, res) => {
    const r = await discounts.update(req.params.id, req.body || {});
    await economyAudit.record({ ...ctxOf(req), action: "update", entity: "discount", entityId: req.params.id, before: r.before, after: r.after });
    ok(res, r);
  })
);
router.patch(
  "/discounts/:id/activate",
  requireEconomyPermission(CAPABILITIES.MANAGE_DISCOUNT),
  ctrl(async (req, res) => {
    const r = await discounts.setActive(req.params.id, true);
    await economyAudit.record({ ...ctxOf(req), action: "activate", entity: "discount", entityId: req.params.id, before: r.before, after: r.after });
    ok(res, r);
  })
);
router.patch(
  "/discounts/:id/deactivate",
  requireEconomyPermission(CAPABILITIES.MANAGE_DISCOUNT),
  ctrl(async (req, res) => {
    const r = await discounts.setActive(req.params.id, false);
    await economyAudit.record({ ...ctxOf(req), action: "deactivate", entity: "discount", entityId: req.params.id, before: r.before, after: r.after });
    ok(res, r);
  })
);
router.delete(
  "/discounts/:id",
  requireEconomyPermission(CAPABILITIES.MANAGE_DISCOUNT),
  ctrl(async (req, res) => {
    const r = await discounts.remove(req.params.id);
    await economyAudit.record({ ...ctxOf(req), action: "delete", entity: "discount", entityId: req.params.id, before: r.before });
    ok(res, r);
  })
);

// ── SEASONS ──────────────────────────────────────────────────────────────────
router.get(
  "/seasons",
  requireEconomyPermission(CAPABILITIES.VIEW),
  ctrl(async (req, res) => ok(res, { seasons: await seasons.list() }))
);
router.get(
  "/seasons/:key",
  requireEconomyPermission(CAPABILITIES.VIEW),
  ctrl(async (req, res) => {
    const s = await seasons.get(req.params.key);
    if (!s) throw new Error("NOT_FOUND");
    ok(res, { season: s });
  })
);
router.post(
  "/seasons",
  requireEconomyPermission(CAPABILITIES.MANAGE_SEASON),
  ctrl(async (req, res) => {
    const doc = await seasons.create(req.body || {});
    await economyAudit.record({ ...ctxOf(req), action: "create", entity: "season", entityId: doc.key, after: doc });
    ok(res, { season: doc }, 201);
  })
);
router.put(
  "/seasons/:key",
  requireEconomyPermission(CAPABILITIES.MANAGE_SEASON),
  ctrl(async (req, res) => {
    const r = await seasons.update(req.params.key, req.body || {});
    await economyAudit.record({ ...ctxOf(req), action: "update", entity: "season", entityId: req.params.key, before: r.before, after: r.after });
    ok(res, r);
  })
);
router.patch(
  "/seasons/:key/activate",
  requireEconomyPermission(CAPABILITIES.MANAGE_SEASON),
  ctrl(async (req, res) => {
    const r = await seasons.setActive(req.params.key, true);
    await economyAudit.record({ ...ctxOf(req), action: "activate", entity: "season", entityId: req.params.key, before: r.before, after: r.after });
    ok(res, r);
  })
);
router.patch(
  "/seasons/:key/deactivate",
  requireEconomyPermission(CAPABILITIES.MANAGE_SEASON),
  ctrl(async (req, res) => {
    const r = await seasons.setActive(req.params.key, false);
    await economyAudit.record({ ...ctxOf(req), action: "deactivate", entity: "season", entityId: req.params.key, before: r.before, after: r.after });
    ok(res, r);
  })
);

// ── ANALYTICS (read-only) ────────────────────────────────────────────────────
router.get("/analytics/overview", requireEconomyPermission(CAPABILITIES.ANALYTICS), ctrl(async (req, res) => ok(res, await analytics.overview(req.query))));
router.get("/analytics/most-purchased", requireEconomyPermission(CAPABILITIES.ANALYTICS), ctrl(async (req, res) => ok(res, { items: await analytics.mostPurchased(req.query) })));
router.get("/analytics/most-sent", requireEconomyPermission(CAPABILITIES.ANALYTICS), ctrl(async (req, res) => ok(res, { items: await analytics.mostSent(req.query) })));
router.get("/analytics/most-received", requireEconomyPermission(CAPABILITIES.ANALYTICS), ctrl(async (req, res) => ok(res, { items: await analytics.mostReceived(req.query) })));
router.get("/analytics/revenue", requireEconomyPermission(CAPABILITIES.ANALYTICS), ctrl(async (req, res) => ok(res, { items: await analytics.revenueByItem(req.query) })));
router.get("/analytics/spending", requireEconomyPermission(CAPABILITIES.ANALYTICS), ctrl(async (req, res) => ok(res, await analytics.spending(req.query))));
router.get("/analytics/item/:key", requireEconomyPermission(CAPABILITIES.ANALYTICS), ctrl(async (req, res) => ok(res, await analytics.itemStats(req.params.key, req.query))));

// ── AUDIT LOG ────────────────────────────────────────────────────────────────
router.get(
  "/audit-logs",
  requireEconomyPermission(CAPABILITIES.AUDIT),
  ctrl(async (req, res) => ok(res, await economyAudit.list(req.query)))
);

module.exports = router;
