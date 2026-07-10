const path = require("path");

const express = require("express");
const dotenv = require("dotenv");
const morgan = require("morgan");
const cors = require("cors");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const hpp = require("hpp");
const helmet = require("helmet");
const xss = require("xss-clean");
const mongoSanitize = require("express-mongo-sanitize");
const logger = require("./utils/logger");
const { renderMetrics, contentType, metrics } = require("./utils/metrics");

dotenv.config();
const ApiError = require("./utils/apiError");
const globalError = require("./middlewares/errorMiddleware");
const dbConnection = require("./config/database");
const { runProductionChecks } = require("./scripts/validateProductionChecks");
// Routes
const mountRoutes = require("./routes");

function parseCorsOrigins(raw) {
  return String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildCorsConfig() {
  const isProd = process.env.NODE_ENV === "production";
  const origins = parseCorsOrigins(process.env.CORS_ORIGINS);
  if (isProd) {
    if (!origins.length) {
      throw new Error("CORS_ORIGINS_MISSING");
    }
    if (origins.includes("*")) {
      throw new Error("CORS_WILDCARD_FORBIDDEN_IN_PRODUCTION");
    }
  }
  return {
    origin: origins.length ? origins : true,
    credentials: true,
  };
}

const corsConfig = buildCorsConfig();

// express app
const app = express();

// Enable other domains to access your application
app.use(helmet());
app.use(cors(corsConfig));
app.options("*", cors(corsConfig));

// compress all responses
app.use(compression());

// Stripe webhooks need raw body — must run before express.json
const {
  stripePaymentsWebhook,
} = require("./controllers/paymentWebhookController");
app.post(
  "/api/v1/payments/webhook",
  express.raw({ type: "application/json" }),
  stripePaymentsWebhook,
);

// Middlewares
app.use(express.json({ limit: "20kb" }));
const ALLOWED_UPLOAD_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif",
  ".mp4", ".webm", ".mov", ".avi",
  ".mp3", ".ogg", ".wav", ".aac",
  ".pdf", ".svg",
]);
app.use("/uploads", (req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  if (!ALLOWED_UPLOAD_EXTS.has(ext)) return res.status(404).end();
  next();
}, express.static(path.join(__dirname, "uploads"), { dotfiles: "deny", index: false }));
app.use("/games", express.static(path.join(__dirname, "games")));
app.use(mongoSanitize());
app.use(xss());

if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
  console.log(`mode: ${process.env.NODE_ENV}`);
}

// Limit each IP to 100 requests per `window` (here, per 15 minutes)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message:
    "Too many accounts created from this IP, please try again after an hour",
});

// Apply the rate limiting middleware to all requests
app.use("/api", limiter);

// Middleware to protect against HTTP Parameter Pollution attacks
app.use(
  hpp({
    whitelist: [],
  }),
);

// Mount Routes
mountRoutes(app);

app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", contentType());
    res.end(await renderMetrics());
  } catch (err) {
    logger.error("metrics_render_failed", {
      reason: err?.message || "unknown",
    });
    res.status(500).json({ status: "error" });
  }
});

// Favicon - تجنب رسالة 404
app.get("/favicon.ico", (req, res) => res.status(204).end());

// Landing page – صفحة تحميل التطبيق
const landingDir = path.join(__dirname, "../landing");
const referralInviteService = require("./modules/referral/services/referralInviteService");
const SCHEME = process.env.REFERRAL_DEEP_LINK_SCHEME || "tam";

app.use(express.static(landingDir));
app.get("/", (req, res) => {
  res.sendFile(path.join(landingDir, "index.html"));
});

app.get("/invite/:code", async (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  const resolved = await referralInviteService.resolveInviteCode(code);
  const deepLink = `${SCHEME}://invite/${code}`;
  const playStore = process.env.ANDROID_STORE_URL || "";
  const appStore = process.env.IOS_STORE_URL || "";
  const referrerName = resolved.ok ? resolved.referrerName : "";
  const valid = resolved.ok;

  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>دعوة للانضمام</title>
  <meta property="og:title" content="انضم عبر دعوة صديق"/>
  <style>
    body{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
    .card{max-width:420px;background:#1e293b;border-radius:16px;padding:32px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4)}
    h1{font-size:1.5rem;margin:0 0 8px}
    .code{font-size:2rem;letter-spacing:.2em;font-weight:700;color:#38bdf8;margin:16px 0}
    .btn{display:block;margin:8px 0;padding:14px;border-radius:10px;text-decoration:none;font-weight:600}
    .primary{background:#38bdf8;color:#0f172a}
    .secondary{background:#334155;color:#f8fafc}
    .err{color:#f87171}
  </style>
  <script>
    (function(){
      var deep="${deepLink.replace(/"/g, '\\"')}";
      var isMobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if(isMobile){ window.location.href=deep; }
    })();
  </script>
</head>
<body>
  <div class="card">
    <h1>${valid ? `دعوة من ${referrerName}` : "كود دعوة"}</h1>
    ${valid ? "<p>انضم الآن واحصل على مكافآت الترحيب</p>" : '<p class="err">كود غير صالح</p>'}
    <div class="code">${code}</div>
    <a class="btn primary" href="${deepLink}">فتح التطبيق</a>
    ${playStore ? `<a class="btn secondary" href="${playStore}">تحميل من Google Play</a>` : ""}
    ${appStore ? `<a class="btn secondary" href="${appStore}">تحميل من App Store</a>` : ""}
  </div>
</body>
</html>`);
});

app.get("/games/trix", (req, res) => res.redirect("/games/trix/"));

app.all("*", (req, res, next) => {
  next(new ApiError(`Can't find this route: ${req.originalUrl}`, 400));
});

// Global error handling middleware for express
app.use(globalError);

const http = require("http");
const { Server } = require("socket.io");
const { initRTC } = require("./sockets/rtc");
const { initTableGame } = require("./sockets/tableGame");
const { initSocial } = require("./sockets/social");
const { initSupport } = require("./sockets/support");
const { initDeposit } = require("./sockets/deposit");
const { initGameServer } = require("./socket");
const { setupSocketIoRedis } = require("./utils/realtimeRedis");

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: corsConfig,
});

const { setMainIo } = require("./utils/lobbyRealtime");
const { setMainIo: setIslandJackpotIo } = require("./utils/islandJackpotRealtime");
setMainIo(io);
setIslandJackpotIo(io);

let server;
let realtimeRedis = null;

async function startServer() {
  await dbConnection();
  const { registerDomainListeners } = require("./domain/listeners/registerDomainListeners");
  registerDomainListeners();
  const { probeMongoTransactions } = require("./services/walletLedgerService");
  await probeMongoTransactions();
  await runProductionChecks({ skipSmoke: true });

  realtimeRedis = await setupSocketIoRedis(io);
  if (realtimeRedis.enabled) {
    logger.info("socketio_redis_enabled");
    const pokerQueueRedis = require("./utils/redis/pokerQueueRedis");
    const pokerCollusionGuard = require("./services/pokerCollusionGuard");
    pokerQueueRedis.setRedisClient(realtimeRedis.commandClient);
    pokerCollusionGuard.setRedisClient(realtimeRedis.commandClient);
    const islandJackpotCache = require("./utils/islandJackpotCache");
    islandJackpotCache.attachRedisClient(realtimeRedis.commandClient);
  }

  const { startPokerTableGc } = require("./services/pokerTableGcService");
  const {
    runBootSanitizer,
    startTableGc,
  } = require("./services/tableGcService");

  await runBootSanitizer({ redis: realtimeRedis?.commandClient || null });

  startPokerTableGc();

  initRTC(io);
  initTableGame(io, { redis: realtimeRedis?.commandClient || null });
  initSocial(io, { redis: realtimeRedis?.commandClient || null });
  initSupport(io);
  initDeposit(io);
  initGameServer(io, { redis: realtimeRedis?.commandClient || null });

  const { startEngine: startTournamentEngine } = require("./services/tournamentEngineService");
  startTournamentEngine();

  startTableGc(io, { redis: realtimeRedis?.commandClient || null });

  // VIP membership: expiration sweep + Monday cashback precompute.
  const vipLevelCache = require("./utils/vipLevelCache");
  vipLevelCache.attachRedisClient(realtimeRedis?.commandClient || null);
  const { startVipEngine } = require("./services/vipService");
  startVipEngine();

  const PORT = process.env.PORT || 1099;
  server = httpServer.listen(PORT, () => {
    logger.info("server_started", { port: PORT });
  });
}

startServer().catch((err) => {
  logger.error("server_start_failed", { reason: err?.message || "unknown" });
  process.exit(1);
});

// Handle rejection outside express
process.on("unhandledRejection", (err) => {
  logger.error("unhandled_rejection", {
    name: err?.name,
    message: err?.message,
  });
  metrics.errorsTotal.inc({ type: "unhandled_rejection" });
  if (server) {
    server.close(() => {
      console.error(`Shutting down....`);
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
});

process.on("uncaughtException", (err) => {
  logger.error("uncaught_exception", {
    name: err?.name,
    message: err?.message,
  });
  metrics.errorsTotal.inc({ type: "uncaught_exception" });
});
