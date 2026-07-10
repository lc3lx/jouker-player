"use strict";

const asyncHandler = require("express-async-handler");
const referralInviteService = require("../modules/referral/services/referralInviteService");
const referralDeepLinkService = require("../modules/referral/services/referralDeepLinkService");

const SCHEME = process.env.REFERRAL_DEEP_LINK_SCHEME || "tam";
const APP_STORE_URL = process.env.APP_STORE_URL || "";
const PLAY_STORE_URL = process.env.PLAY_STORE_URL || "";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildLandingHtml(code, resolved) {
  const safeCode = escapeHtml(code);
  const deepLink = `${SCHEME}://invite/${safeCode}`;
  const referrer = resolved?.ok ? escapeHtml(resolved.referrerName || "") : "";
  const title = resolved?.ok ? "دعوة للانضمام" : "كود دعوة";
  const subtitle = resolved?.ok
    ? `تمت دعوتك من ${referrer || "صديق"}`
    : "الكود غير صالح أو منتهي";

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${title}</title>
  <meta property="og:title" content="${title}"/>
  <meta property="og:description" content="${subtitle}"/>
  <style>
    body{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;margin:0;padding:2rem;text-align:center}
    .card{max-width:420px;margin:2rem auto;background:#1e293b;border-radius:16px;padding:2rem}
    .code{font-size:2rem;letter-spacing:.2em;font-weight:700;margin:1rem 0}
    a.btn{display:inline-block;margin:.5rem;padding:.75rem 1.25rem;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px}
    .muted{color:#94a3b8;font-size:.9rem}
  </style>
  <script>
    (function(){
      var deep="${deepLink}";
      setTimeout(function(){ window.location.href = deep; }, 600);
    })();
  </script>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p class="muted">${subtitle}</p>
    <div class="code">${safeCode}</div>
    <p><a class="btn" href="${deepLink}">فتح التطبيق</a></p>
    ${PLAY_STORE_URL ? `<p><a class="btn" href="${escapeHtml(PLAY_STORE_URL)}">Google Play</a></p>` : ""}
    ${APP_STORE_URL ? `<p><a class="btn" href="${escapeHtml(APP_STORE_URL)}">App Store</a></p>` : ""}
  </div>
</body>
</html>`;
}

const mountInviteLanding = (app) => {
  app.get("/invite/:code", asyncHandler(async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const resolved = await referralInviteService.resolveInviteCode(code);
    const links = referralDeepLinkService.buildLinks(code);

    if (req.accepts(["html", "json"]) === "json") {
      return res.status(200).json({
        status: "success",
        data: {
          code,
          valid: resolved.ok,
          referrerName: resolved.referrerName || null,
          links,
        },
      });
    }

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(buildLandingHtml(code, resolved));
  }));

  app.get("/.well-known/assetlinks.json", (_req, res) => {
    const pkg = process.env.ANDROID_APP_PACKAGE || "";
    const fp = process.env.ANDROID_APP_SHA256 || "";
    if (!pkg || !fp) {
      return res.status(404).json({ status: "not_configured" });
    }
    res.json([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: pkg,
          sha256_cert_fingerprints: [fp],
        },
      },
    ]);
  });

  app.get("/apple-app-site-association", (_req, res) => {
    const appId = process.env.IOS_APP_TEAM_BUNDLE || "";
    if (!appId) {
      return res.status(404).json({ status: "not_configured" });
    }
    res.json({
      applinks: {
        apps: [],
        details: [{ appID: appId, paths: ["/invite/*"] }],
      },
    });
  });
};

module.exports = mountInviteLanding;
