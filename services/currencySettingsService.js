const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const SystemSettings = require("../models/systemSettingsModel");
const { chipPackages: defaultPackagesFromEnv, chipsPerUsd: envChipsPerUsd } = require("../utils/appConfig");

function normalizePackage(row, rate) {
  const chips = Math.max(0, Math.floor(Number(row.chips) || 0));
  const bonusPercent = Math.min(100, Math.max(0, Math.floor(Number(row.bonusPercent) || 0)));
  const priceUsd = Math.max(0, Number(row.priceUsd) || 0);
  const id = String(row.id || "").trim();
  if (!id || chips <= 0) return null;

  const bonusChips = Math.floor((chips * bonusPercent) / 100);
  return {
    id,
    chips,
    bonusPercent,
    bonusChips,
    totalChips: chips + bonusChips,
    priceUsd: Number(priceUsd.toFixed(2)),
    badge: row.badge ? String(row.badge).trim() : null,
    label: row.label ? String(row.label).trim() : null,
    isActive: row.isActive !== false && row.isActive !== "false",
    promoMeta: row.promoMeta && typeof row.promoMeta === "object" ? row.promoMeta : null,
    /** Derived: chips per 1 USD for this package (admin reference). */
    effectiveChipsPerUsd: priceUsd > 0 ? Math.round((chips + bonusChips) / priceUsd) : rate,
  };
}

function mapPackageBadge(badge) {
  if (!badge) return null;
  if (badge === "popular") return { kind: "popular", label: "الأكثر شعبية" };
  const m = /^bonus_(\d+)$/.exec(badge);
  if (m) return { kind: "bonus", label: `+${m[1]}% مجاناً`, bonusPercent: parseInt(m[1], 10) };
  return { kind: "bonus", label: badge };
}

function isPromoActive(promoMeta) {
  if (!promoMeta || typeof promoMeta !== "object") return true;
  const exp = promoMeta.expiresAt;
  if (!exp) return true;
  const t = new Date(exp).getTime();
  return Number.isFinite(t) && Date.now() <= t;
}

async function loadSettingsDoc() {
  return SystemSettings.getDefaults();
}

async function getCurrencyConfig() {
  const doc = await loadSettingsDoc();
  const rate = Math.max(1, Math.floor(Number(doc.chipsPerUsd) || envChipsPerUsd()));
  const currencyName = String(doc.currencyName || "رقاقة").trim() || "رقاقة";

  const rawPackages =
    Array.isArray(doc.chipPackages) && doc.chipPackages.length > 0
      ? doc.chipPackages
      : defaultPackagesFromEnv();

  const packages = rawPackages
    .map((p) => normalizePackage(p, rate))
    .filter(Boolean)
    .filter((p) => p.isActive && isPromoActive(p.promoMeta));

  return {
    currencyName,
    currencyCode: "CHIPS",
    chipsPerUsd: rate,
    packages,
  };
}

/** User-facing packages — no fiat price exposed. */
function toPublicPackages(packages) {
  return packages.map((p) => ({
    id: p.id,
    chips: p.chips,
    totalChips: p.totalChips,
    bonusPercent: p.bonusPercent,
    label: p.label,
    badge: mapPackageBadge(p.badge),
  }));
}

async function getPublicCurrencySummary() {
  const cfg = await getCurrencyConfig();
  return {
    currencyName: cfg.currencyName,
    currencyCode: cfg.currencyCode,
    packages: toPublicPackages(cfg.packages),
  };
}

async function getAdminCurrencySettings() {
  const cfg = await getCurrencyConfig();
  return {
    currencyName: cfg.currencyName,
    chipsPerUsd: cfg.chipsPerUsd,
    packages: cfg.packages,
  };
}

function parsePackagesInput(raw) {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ApiError("Invalid chipPackages JSON", 400);
    }
  }
  if (Array.isArray(raw)) return raw;
  throw new ApiError("chipPackages must be an array", 400);
}

exports.getCurrencyConfig = getCurrencyConfig;
exports.getPublicCurrencySummary = getPublicCurrencySummary;
exports.mapPackageBadge = mapPackageBadge;

exports.adminGetCurrencySettings = asyncHandler(async (req, res) => {
  const data = await getAdminCurrencySettings();
  res.status(200).json({ status: "success", data });
});

exports.adminUpdateCurrencySettings = asyncHandler(async (req, res, next) => {
  const doc = await loadSettingsDoc();
  const updates = {};

  if (typeof req.body.currencyName !== "undefined") {
    const name = String(req.body.currencyName || "").trim();
    if (!name) return next(new ApiError("currencyName is required", 400));
    updates.currencyName = name;
  }

  if (typeof req.body.chipsPerUsd !== "undefined") {
    const rate = Math.floor(Number(req.body.chipsPerUsd));
    if (!Number.isFinite(rate) || rate < 1) {
      return next(new ApiError("chipsPerUsd must be a positive number", 400));
    }
    updates.chipsPerUsd = rate;
  }

  if (typeof req.body.chipPackages !== "undefined") {
    const raw = parsePackagesInput(req.body.chipPackages);
    const rate = Math.max(
      1,
      Math.floor(Number(updates.chipsPerUsd ?? doc.chipsPerUsd) || envChipsPerUsd())
    );
    const normalized = raw.map((p) => normalizePackage(p, rate)).filter(Boolean);
    if (normalized.length === 0) {
      return next(new ApiError("At least one valid package is required", 400));
    }
    updates.chipPackages = normalized.map((p) => ({
      id: p.id,
      chips: p.chips,
      priceUsd: p.priceUsd,
      bonusPercent: p.bonusPercent,
      badge: p.badge,
      label: p.label,
      isActive: p.isActive,
      promoMeta: p.promoMeta,
    }));
  }

  if (Object.keys(updates).length === 0) {
    return next(new ApiError("No updates provided", 400));
  }

  Object.assign(doc, updates);
  await doc.save();

  const data = await getAdminCurrencySettings();
  res.status(200).json({ status: "success", data });
});
