"use strict";

/**
 * Live catalog updates. Admin CMS mutations invalidate the catalog cache and
 * call `broadcastCatalogUpdated()`; every connected player receives a light
 * `catalog_updated` signal and re-fetches the catalog — no server restart.
 *
 * Socket namespaces (`/game`, `/table-game`) register themselves here at init.
 * Emitting to a namespace fans out to all sockets across the cluster via the
 * socket.io Redis adapter, so a mutation on one instance reaches every player.
 */

const logger = require("../utils/logger");

/** @type {Set<import('socket.io').Namespace>} */
const _namespaces = new Set();
let _version = 0;

/** Called once per game namespace at socket init. */
function registerNamespace(nsp) {
  if (nsp && typeof nsp.emit === "function") _namespaces.add(nsp);
}

/** Test/ops helper. */
function _resetForTests() {
  _namespaces.clear();
  _version = 0;
}

/**
 * Signal all connected clients that the catalog changed. Payload is intentionally
 * small — clients respond by calling the catalog API with force-refresh.
 * @param {{ reason?: string, entity?: string, keys?: string[] }} [meta]
 */
function broadcastCatalogUpdated(meta = {}) {
  _version += 1;
  const payload = {
    version: _version,
    at: Date.now(),
    reason: meta.reason || "catalog_changed",
    entity: meta.entity || "item",
    keys: Array.isArray(meta.keys) ? meta.keys.slice(0, 200) : undefined,
  };
  let reached = 0;
  for (const nsp of _namespaces) {
    try {
      nsp.emit("catalog_updated", payload);
      reached += 1;
    } catch (e) {
      logger.warn("catalog_broadcast_failed", { reason: e?.message || "unknown" });
    }
  }
  logger.info("catalog_updated_broadcast", { version: _version, namespaces: reached, entity: payload.entity });
  return { version: _version, namespaces: reached };
}

/**
 * Emit an arbitrary live event to every game namespace (e.g. "cosmetics_updated",
 * "vip_updated"). Clients react by re-fetching the affected catalog/config.
 */
function broadcast(event, payload = {}) {
  const body = { at: Date.now(), ...payload };
  let reached = 0;
  for (const nsp of _namespaces) {
    try {
      nsp.emit(String(event), body);
      reached += 1;
    } catch (e) {
      logger.warn("live_broadcast_failed", { event, reason: e?.message || "unknown" });
    }
  }
  logger.info("live_broadcast", { event, namespaces: reached });
  return { event, namespaces: reached };
}

module.exports = { registerNamespace, broadcastCatalogUpdated, broadcast, _resetForTests };
