"use strict";

/**
 * VIP store pricing — admin overrides on top of vipConfig benefits.
 * Benefits (cashback, daily chips, quiz, etc.) always come from vipConfig.
 */
const SystemSettings = require("../models/systemSettingsModel");
const {
  VIP_LEVELS,
  VIP_LEVEL_CONFIG,
  publicBenefits,
} = require("../config/vipConfig");

function defaultPricingRows() {
  return VIP_LEVELS.map((level) => {
    const cfg = VIP_LEVEL_CONFIG[level];
    return {
      level,
      priceUsd: cfg?.priceUsd ?? 0,
      isActive: true,
    };
  });
}

function normalizePricingRow(row) {
  const level = String(row?.level || "").toLowerCase().trim();
  if (!VIP_LEVELS.includes(level)) return null;
  const priceUsd = Number(row?.priceUsd);
  return {
    level,
    priceUsd: Number.isFinite(priceUsd) && priceUsd >= 0 ? priceUsd : 0,
    isActive: row?.isActive !== false,
  };
}

async function loadPricingOverrides() {
  const doc = await SystemSettings.getDefaults();
  const raw = doc?.vipPackages;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const map = new Map();
  for (const row of raw) {
    const n = normalizePricingRow(row);
    if (n) map.set(n.level, n);
  }
  return map.size > 0 ? map : null;
}

/** Public tier list for store (benefits from config + admin price). */
async function getPublicVipTiers() {
  const overrides = await loadPricingOverrides();
  const out = [];
  for (const level of VIP_LEVELS) {
    const benefits = publicBenefits(level);
    if (!benefits) continue;
    const ov = overrides?.get(level);
    if (ov && ov.isActive === false) continue;
    out.push({
      ...benefits,
      priceUsd: ov?.priceUsd ?? benefits.priceUsd,
    });
  }
  return out;
}

async function getAdminPricingConfig() {
  const overrides = await loadPricingOverrides();
  return VIP_LEVELS.map((level) => {
    const base = VIP_LEVEL_CONFIG[level];
    const ov = overrides?.get(level);
    return {
      level,
      priceUsd: ov?.priceUsd ?? base.priceUsd,
      isActive: ov ? ov.isActive !== false : true,
      benefits: publicBenefits(level),
    };
  });
}

async function saveAdminPricingConfig(packages) {
  if (!Array.isArray(packages)) {
    throw new Error("packages must be an array");
  }
  const normalized = packages
    .map(normalizePricingRow)
    .filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("No valid VIP packages");
  }
  const doc = await SystemSettings.getDefaults();
  doc.vipPackages = normalized;
  await doc.save();
  return getAdminPricingConfig();
}

async function priceUsdForLevel(level) {
  const tiers = await getPublicVipTiers();
  const row = tiers.find((t) => t.level === level);
  return row?.priceUsd ?? VIP_LEVEL_CONFIG[level]?.priceUsd ?? 0;
}

module.exports = {
  defaultPricingRows,
  getPublicVipTiers,
  getAdminPricingConfig,
  saveAdminPricingConfig,
  priceUsdForLevel,
};
