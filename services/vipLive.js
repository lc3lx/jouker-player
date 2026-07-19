"use strict";

/**
 * Live VIP config updates. Admin level/reward edits reload the in-memory sync
 * registries (so seat/benefit resolution reflects changes immediately) and push
 * a `vip_updated` signal to connected clients. Lazy requires avoid load cycles.
 *
 * @param {{ reason?: string, entity?: string, keys?: string[], levels?: boolean, rewards?: boolean }} [meta]
 */
async function refresh(meta = {}) {
  const jobs = [];
  if (meta.levels !== false) {
    // eslint-disable-next-line global-require
    jobs.push(require("./vipLevelRegistry").refresh().catch(() => {}));
  }
  if (meta.rewards) {
    // eslint-disable-next-line global-require
    jobs.push(require("./vipRewardService").refresh().catch(() => {}));
  }
  await Promise.all(jobs);
  // eslint-disable-next-line global-require
  return require("./economyBroadcast").broadcast("vip_updated", {
    reason: meta.reason || "vip_changed",
    entity: meta.entity || "vip_level",
    keys: Array.isArray(meta.keys) ? meta.keys.slice(0, 200) : undefined,
  });
}

module.exports = { refresh };
