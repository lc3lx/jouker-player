const asyncHandler = require("express-async-handler");
const bcrypt = require("bcryptjs");
const ApiError = require("../utils/apiError");
const User = require("../models/userModel");
const createToken = require("../utils/createToken");
const { normalizePreferences, publicSettings } = require("../utils/userPreferences");

const ALLOWED_KEYS = new Set([
  "language",
  "notifications",
  "soundEffects",
  "twoFactorEnabled",
  "hideProfile",
  "loginAlerts",
]);

function parseBool(v) {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return undefined;
}

function buildPreferencePatch(body) {
  const patch = {};
  if (typeof body.language !== "undefined") {
    const lang = String(body.language || "").toLowerCase();
    if (lang !== "ar" && lang !== "en") {
      throw new ApiError("Invalid language", 400);
    }
    patch.language = lang;
  }
  for (const key of [
    "notifications",
    "soundEffects",
    "twoFactorEnabled",
    "hideProfile",
    "loginAlerts",
  ]) {
    if (typeof body[key] !== "undefined") {
      const b = parseBool(body[key]);
      if (typeof b === "undefined") throw new ApiError(`Invalid boolean for ${key}`, 400);
      patch[key] = b;
    }
  }
  return patch;
}

exports.getUserSettings = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("email preferences sessionVersion");
  res.status(200).json({
    status: "success",
    data: publicSettings(user),
  });
});

exports.updateUserSettings = asyncHandler(async (req, res, next) => {
  const patch = buildPreferencePatch(req.body || {});
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    return next(new ApiError("No settings to update", 400));
  }

  for (const k of keys) {
    if (!ALLOWED_KEYS.has(k)) {
      return next(new ApiError(`Unknown setting: ${k}`, 400));
    }
  }

  const user = await User.findById(req.user._id).select("email preferences sessionVersion");
  if (!user) return next(new ApiError("User not found", 404));

  const merged = normalizePreferences({ ...user.preferences, ...patch });
  user.preferences = merged;
  await user.save();

  res.status(200).json({
    status: "success",
    data: publicSettings(user),
  });
});

exports.logoutAllDevices = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user._id);
  if (!user) return next(new ApiError("User not found", 404));

  user.sessionVersion = Math.floor(Number(user.sessionVersion) || 0) + 1;
  await user.save();

  res.status(200).json({
    status: "success",
    message: "Logged out from all devices",
  });
});

exports.changeMyPassword = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user._id);
  if (!user) return next(new ApiError("User not found", 404));

  const currentPassword = req.body?.currentPassword;
  const password = req.body?.password;
  const passwordConfirm = req.body?.passwordConfirm;

  if (!currentPassword || !password || !passwordConfirm) {
    return next(new ApiError("currentPassword, password and passwordConfirm are required", 400));
  }
  if (password.length < 6) {
    return next(new ApiError("Password too short", 400));
  }
  if (password !== passwordConfirm) {
    return next(new ApiError("Password confirmation incorrect", 400));
  }

  const ok = await bcrypt.compare(String(currentPassword), user.password);
  if (!ok) return next(new ApiError("Incorrect current password", 401));

  user.password = password;
  user.passwordChangedAt = Date.now();
  user.sessionVersion = Math.floor(Number(user.sessionVersion) || 0) + 1;
  await user.save();

  const token = createToken(user._id, user.sessionVersion);
  const safe = user.toObject();
  delete safe.password;

  res.status(200).json({
    status: "success",
    data: safe,
    token,
  });
});
