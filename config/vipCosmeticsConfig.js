"use strict";

/**
 * COMPAT SHIM — VIP → table theme + face-down card backs.
 *
 * The reward mapping is now DB-driven and admin-managed in services/vipRewardService.js.
 * This module is kept so existing `require("../config/vipCosmeticsConfig")` call
 * sites keep working; it re-exports the service's sync accessors and the legacy
 * mapping (as `VIP_COSMETICS`) used as the seed/fallback.
 */

const vipRewardService = require("../services/vipRewardService");

module.exports = {
  /** Legacy static mapping — seed + fallback only. Live data comes from vipRewardService. */
  VIP_COSMETICS: vipRewardService.LEGACY_VIP_COSMETICS,
  vipCosmeticsForLevel: vipRewardService.vipCosmeticsForLevel,
  resolveEffectiveSeatCosmetics: vipRewardService.resolveEffectiveSeatCosmetics,
};
