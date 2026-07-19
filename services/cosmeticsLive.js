"use strict";

/**
 * Live cosmetics updates. Admin CMS mutations call this so every connected
 * client refetches the affected catalog and re-resolves seat cosmetics without
 * reconnecting. VIP reward changes also affect table felt / card backs, so those
 * refresh the VIP reward registry too. Lazy requires avoid load cycles.
 *
 * @param {{ reason?: string, entity?: string, keys?: string[], refreshVipRewards?: boolean }} [meta]
 */
function refresh(meta = {}) {
  if (meta.refreshVipRewards) {
    // eslint-disable-next-line global-require
    require("./vipRewardService").refresh().catch(() => {});
  }
  // eslint-disable-next-line global-require
  return require("./economyBroadcast").broadcast("cosmetics_updated", {
    reason: meta.reason || "cosmetics_changed",
    entity: meta.entity || "cosmetic",
    keys: Array.isArray(meta.keys) ? meta.keys.slice(0, 200) : undefined,
  });
}

module.exports = { refresh };
