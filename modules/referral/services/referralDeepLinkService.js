"use strict";

const SCHEME = process.env.REFERRAL_DEEP_LINK_SCHEME || "tam";
const PUBLIC_URL = (process.env.APP_PUBLIC_URL || process.env.SERVER_PUBLIC_URL || "").replace(/\/$/, "");

function buildLinks(inviteCode) {
  const code = String(inviteCode || "").trim().toUpperCase();
  const deepLink = `${SCHEME}://invite/${code}`;
  const httpsLink = PUBLIC_URL ? `${PUBLIC_URL}/invite/${code}` : null;
  return { inviteCode: code, deepLink, httpsLink, shareText: `انضم إليّ في التطبيق! كود الدعوة: ${code}` };
}

module.exports = { buildLinks, SCHEME, PUBLIC_URL };
