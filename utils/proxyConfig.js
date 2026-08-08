"use strict";

/**
 * Proxy / VPN connection policy.
 *
 * ALLOW_VPN_PROXY=1 (default): do not punish or hard-block clients that look like VPN/proxy.
 * TRUST_PROXY_HOPS / TRUST_PROXY: Express + Socket.IO honor X-Forwarded-For behind nginx.
 */

function envFlag(name, defaultTrue = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultTrue;
  const v = String(raw).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(v)) return false;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  return defaultTrue;
}

/** End-user VPN / HTTP proxy is allowed (default on). */
function allowVpnProxy() {
  return envFlag("ALLOW_VPN_PROXY", true);
}

/**
 * Shared exit-node IPs (common on VPN) should not trigger public-table IP collusion.
 * Defaults to the same as ALLOW_VPN_PROXY.
 */
function allowSharedVpnIp() {
  if (process.env.ALLOW_SHARED_VPN_IP !== undefined && process.env.ALLOW_SHARED_VPN_IP !== "") {
    return envFlag("ALLOW_SHARED_VPN_IP", true);
  }
  return allowVpnProxy();
}

/**
 * Express `trust proxy` setting: number of hops, `true`, or `false`.
 * - TRUST_PROXY=true|false
 * - TRUST_PROXY_HOPS=N (preferred when behind nginx)
 * Default: 1 hop so reverse-proxy / load-balancer deployments work out of the box.
 */
function getTrustProxySetting() {
  const explicit = process.env.TRUST_PROXY;
  if (explicit !== undefined && explicit !== "") {
    const v = String(explicit).trim().toLowerCase();
    if (["0", "false", "no", "off"].includes(v)) return false;
    if (["1", "true", "yes", "on"].includes(v)) return true;
  }

  if (process.env.TRUST_PROXY_HOPS !== undefined && process.env.TRUST_PROXY_HOPS !== "") {
    const hops = Number(process.env.TRUST_PROXY_HOPS);
    if (!Number.isInteger(hops) || hops < 0) return false;
    return hops > 0 ? hops : false;
  }

  // Default one hop (nginx → node). Set TRUST_PROXY=0 to disable.
  return 1;
}

function trustsForwardedIp() {
  const setting = getTrustProxySetting();
  return setting === true || (typeof setting === "number" && setting > 0);
}

module.exports = {
  allowVpnProxy,
  allowSharedVpnIp,
  getTrustProxySetting,
  trustsForwardedIp,
  envFlag,
};
