/**
 * FCM push notifications via firebase-admin.
 *
 * Configuration (either):
 *   FIREBASE_SERVICE_ACCOUNT_PATH  — path to the service-account JSON file
 *   FIREBASE_SERVICE_ACCOUNT_JSON — the JSON itself (raw or base64)
 *
 * When neither is set (or firebase-admin is not installed) the service runs
 * in disabled mode: every call is a silent no-op so the app never breaks.
 */
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const DeviceToken = require("../models/deviceTokenModel");

let messaging = null;
let initAttempted = false;

function readServiceAccount() {
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (jsonEnv) {
    const raw = jsonEnv.trim().startsWith("{")
      ? jsonEnv
      : Buffer.from(jsonEnv, "base64").toString("utf8");
    return JSON.parse(raw);
  }
  const pathEnv = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (pathEnv && fs.existsSync(pathEnv)) {
    return JSON.parse(fs.readFileSync(pathEnv, "utf8"));
  }
  const fallbackPath = path.resolve(__dirname, "../secrets/firebase-service-account.json");
  if (fs.existsSync(fallbackPath)) {
    return JSON.parse(fs.readFileSync(fallbackPath, "utf8"));
  }
  return null;
}

function getMessaging() {
  if (initAttempted) return messaging;
  initAttempted = true;
  try {
    const serviceAccount = readServiceAccount();
    if (!serviceAccount) {
      logger.info("push_disabled_no_firebase_credentials");
      return null;
    }
    // eslint-disable-next-line global-require
    const admin = require("firebase-admin");
    const { getMessaging: getFcmMessaging } = require("firebase-admin/messaging");

    const apps = admin.getApps ? admin.getApps() : (admin.apps || []);
    let app = apps.length ? apps[0] : null;
    if (!app) {
      const credential = typeof admin.cert === "function"
        ? admin.cert(serviceAccount)
        : (admin.credential?.cert ? admin.credential.cert(serviceAccount) : null);
      app = admin.initializeApp({ credential });
    }
    messaging = typeof admin.messaging === "function" ? admin.messaging(app) : getFcmMessaging(app);
    logger.info("push_enabled_firebase_initialized");
  } catch (err) {
    logger.warn("push_init_failed", { error: err.message });
    messaging = null;
  }
  return messaging;
}

/** Upsert one device token for a user. */
async function registerDeviceToken(userId, token, platform = "unknown") {
  if (!token || typeof token !== "string" || token.length < 10) {
    throw new Error("INVALID_DEVICE_TOKEN");
  }
  const safePlatform = ["android", "ios", "web"].includes(platform)
    ? platform
    : "unknown";
  await DeviceToken.findOneAndUpdate(
    { token },
    { userId, token, platform: safePlatform },
    { upsert: true, setDefaultsOnInsert: true }
  );
  return { ok: true };
}

/** Remove a token (logout / user request). */
async function unregisterDeviceToken(token) {
  if (!token) return { ok: true };
  await DeviceToken.deleteOne({ token });
  return { ok: true };
}

const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/**
 * Send a push to every registered device of a user. Fire-and-forget safe:
 * never throws, prunes dead tokens.
 */
async function sendPushToUser(userId, { title, body = "", data = {} } = {}) {
  try {
    const fcm = getMessaging();
    if (!fcm || !userId || !title) return { sent: 0 };

    const rows = await DeviceToken.find({ userId }).limit(20).lean();
    if (!rows.length) return { sent: 0 };

    const tokens = rows.map((r) => r.token);
    const stringData = {};
    for (const [k, v] of Object.entries(data)) stringData[k] = String(v);

    const res = await fcm.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: stringData,
        android: {
          priority: "high",
          notification: {
            channelId: "play_alerts",
            sound: "default",
            priority: "high",
            defaultSound: true,
            defaultVibrateTimings: true,
          },
        },
        apns: {
          payload: {
            aps: {
              alert: { title, body },
              sound: "default",
              badge: 1,
              "content-available": 1,
            },
          },
        },
    });

    const dead = [];
    res.responses.forEach((r, i) => {
      if (!r.success && DEAD_TOKEN_CODES.has(r.error?.code)) {
        dead.push(tokens[i]);
      }
    });
    if (dead.length) {
      await DeviceToken.deleteMany({ token: { $in: dead } });
    }
    return { sent: res.successCount };
  } catch (err) {
    logger.warn("push_send_failed", { error: err.message });
    return { sent: 0 };
  }
}

// --- controllers (mounted in routes/userRoute.js) ---------------------------

const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");

const registerMyDeviceToken = asyncHandler(async (req, res) => {
  const { token, platform } = req.body || {};
  try {
    await registerDeviceToken(req.user._id, token, platform);
  } catch (err) {
    if (err.message === "INVALID_DEVICE_TOKEN") {
      throw new ApiError("رمز الجهاز غير صالح", 400);
    }
    throw err;
  }
  res.status(200).json({ status: "success" });
});

const unregisterMyDeviceToken = asyncHandler(async (req, res) => {
  await unregisterDeviceToken(req.body?.token || "");
  res.status(200).json({ status: "success" });
});

module.exports = {
  sendPushToUser,
  registerDeviceToken,
  unregisterDeviceToken,
  registerMyDeviceToken,
  unregisterMyDeviceToken,
};
