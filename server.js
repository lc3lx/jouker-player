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
app.use(express.static(landingDir));
app.get("/", (req, res) => {
  res.sendFile(path.join(landingDir, "index.html"));
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
