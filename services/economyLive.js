"use strict";

/**
 * Single entry point admin services call after any change that affects what
 * players see/pay: invalidate the shared catalog cache, then broadcast the
 * live `catalog_updated` signal. Lazy-requires break the cache↔discount cycle.
 *
 * @param {{ reason?: string, entity?: string, keys?: string[] }} [meta]
 */
function refresh(meta = {}) {
  // eslint-disable-next-line global-require
  require("./tableInteractionsService").invalidateCatalogCache();
  // eslint-disable-next-line global-require
  return require("./economyBroadcast").broadcastCatalogUpdated(meta);
}

module.exports = { refresh };
