"use strict";

/**
 * Per-request economy decisions shared by the Poseidon, Zenobia and Zeus
 * services: which engine + profile a spin uses, whether paid play / buys are
 * open, the bet limits, and the authoritative buy price.
 *
 * A bonus round always plays the engine version and profile it was opened
 * with (pinned on the session); only new paid spins and new purchases follow
 * the admin-selected profile.
 */

const ApiError = require("../../utils/apiError");
const registry = require("../slotProfiles/registry");
const settingsService = require("../../services/slotEconomySettingsService");

function fail(message, statusCode, code, extra = {}) {
  return new ApiError(message, statusCode, { code, ...extra });
}

/**
 * @param {string} game
 * @param {object|null} session  pinned bonus session, or null for a paid spin
 * @param {number} legacyVersion engine version paid spins use until the game goes live
 * @returns {{ economyVersion: number, profile: object|null, rules: object|undefined }}
 */
function resolveEconomy(game, session, legacyVersion) {
  if (session) {
    const economyVersion = session.economyVersion || legacyVersion;
    if (economyVersion >= registry.ENGINE_VERSIONS[game]) {
      const profile = registry.getProfile(session.profileId);
      return { economyVersion, profile, rules: profile.rules };
    }
    return { economyVersion, profile: null, rules: undefined };
  }
  if (settingsService.isEconomyLive(game)) {
    const profile = settingsService.activeProfile(game);
    return { economyVersion: profile.economyVersion, profile, rules: profile.rules };
  }
  return { economyVersion: legacyVersion, profile: null, rules: undefined };
}

function assertPaidPlayOpen(game) {
  if (!settingsService.getSettings(game).enabled) {
    throw fail("اللعبة متوقفة مؤقتاً للصيانة. جولات البونص المدفوعة تكتمل كالمعتاد.", 503, "game_disabled");
  }
}

/** Effective [min, max] bet: the engine's hard bounds narrowed by admin limits. */
function betLimits(game, floor, ceiling) {
  const s = settingsService.getSettings(game);
  return { min: Math.max(floor, s.minBet), max: Math.min(ceiling, s.maxBet) };
}

/**
 * Authoritative buy price. While a game is not live it keeps its legacy
 * prices (and legacy pause). Once live, the price comes from the active
 * profile and the client must confirm the exact cost it showed the player.
 *
 * @returns {{ cost: number, costMultiplier: number, profile: object|null }}
 */
function quoteBuy(game, { betAmount, superBonus, expectedCost, legacyCost, legacyPaused = false, roundMoney }) {
  const s = settingsService.getSettings(game);
  if (!s.enabled) throw fail("اللعبة متوقفة مؤقتاً للصيانة.", 503, "game_disabled");
  if (superBonus ? !s.superBuyEnabled : !s.buyEnabled) {
    throw fail("شراء هذا البونص متوقف مؤقتاً.", 503, "buy_disabled");
  }
  if (!s.economyLive) {
    if (legacyPaused) {
      throw fail("شراء البونص العادي متوقف مؤقتاً للصيانة. السوبر بونص متاح.", 503, "buy_paused");
    }
    return { cost: roundMoney(betAmount * legacyCost), costMultiplier: legacyCost, profile: null };
  }
  if (settingsService.isStale()) {
    throw fail("تعذّر تأكيد السعر الحالي، حاول بعد لحظات.", 503, "settings_stale");
  }
  const profile = settingsService.activeProfile(game);
  const costMultiplier = superBonus ? profile.buy.superCost : profile.buy.standardCost;
  const cost = roundMoney(betAmount * costMultiplier);
  if (expectedCost == null) {
    throw fail("حدّث التطبيق لشراء البونص.", 426, "client_update_required");
  }
  if (Math.round(Number(expectedCost)) !== cost) {
    throw fail("تغيّر سعر البونص، راجع السعر الجديد.", 409, "price_changed", { cost, costMultiplier, profileId: profile.id });
  }
  return { cost, costMultiplier, profile };
}

module.exports = { resolveEconomy, assertPaidPlayOpen, betLimits, quoteBuy };
