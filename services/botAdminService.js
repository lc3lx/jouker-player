"use strict";

const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const ApiError = require("../utils/apiError");
const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const Player = require("../models/playerModel");
const BotSettings = require("../models/botSettingsModel");
const botPoolService = require("./botPoolService");
const botBehaviorService = require("./botBehaviorService");
const botChatService = require("./botChatService");
const auditService = require("./auditService");
const { PERSONALITIES, SKILLS, AVATAR_CATALOG } = require("../config/botConfig");

function audit(req, event, meta) {
  auditService
    .logEvent({
      event,
      actor: req.user?._id || null,
      meta,
      ip: req.ip,
      userAgent: req.get?.("user-agent"),
    })
    .catch(() => {});
}

/** Push config + roster changes into the live caches so admin edits apply now. */
async function refreshCaches() {
  const s = await BotSettings.getDefaults();
  botBehaviorService.applySettings(s);
  botChatService.applySettings(s);
  await botPoolService.refresh();
}

async function serializeBot(user) {
  const wallet = await Wallet.findOne({ user: user._id }).select("balance").lean();
  const player = await Player.findOne({ user: user._id }).select("stats").lean();
  return {
    id: String(user._id),
    name: user.name,
    country: user.country || null,
    language: user.preferences?.language || null,
    avatar: user.profileImg || user.bot?.avatarKey || null,
    personality: user.bot?.personality || null,
    skill: user.bot?.skill || null,
    biography: user.bot?.biography || null,
    enabled: user.bot?.enabled !== false,
    inUse: !!user.bot?.inUse,
    activity: user.bot?.activity || null,
    vip: !!user.vip?.active,
    balance: wallet?.balance || 0,
    stats: player?.stats || {},
    createdAt: user.createdAt,
    lastOnline: user.lastOnline || null,
  };
}

// ─── catalog CRUD ─────────────────────────────────────────────────────────────
exports.adminListBots = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const filter = { isBot: true };
  if (req.query.enabled === "true") filter["bot.enabled"] = { $ne: false };
  if (req.query.enabled === "false") filter["bot.enabled"] = false;
  const [rows, total] = await Promise.all([
    User.find(filter).sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit),
    User.countDocuments(filter),
  ]);
  const data = await Promise.all(rows.map(serializeBot));
  res.json({ results: data.length, total, page, limit, data });
});

exports.adminGetBot = asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, isBot: true });
  if (!user) throw new ApiError("Bot not found", 404);
  res.json({ data: await serializeBot(user) });
});

exports.adminCreateBot = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (name.length < 2) throw new ApiError("Name required", 400);
  const personality = PERSONALITIES.includes(b.personality) ? b.personality : "professional";
  const skill = SKILLS.includes(b.skill) ? b.skill : "normal";
  const avatarKey = b.avatarKey || AVATAR_CATALOG[0];

  const email = `bot_${crypto.randomBytes(6).toString("hex")}@bots.local`;
  const user = await User.create({
    name,
    email,
    password: crypto.randomBytes(16).toString("hex"),
    country: b.country || "SA",
    profileImg: avatarKey,
    isBot: true,
    preferences: { language: b.language || "ar", notifications: false },
    bot: {
      personality,
      skill,
      biography: String(b.biography || "").slice(0, 300),
      avatarKey,
      themeKey: b.themeKey || null,
      enabled: b.enabled !== false,
      inUse: false,
      activity: "recently_online",
    },
  });
  const wallet = await Wallet.create({
    user: user._id,
    balance: Math.max(0, parseInt(b.balance, 10) || 5_000_000),
    lockedBalance: 0,
  });
  await User.updateOne({ _id: user._id }, { $set: { wallet: wallet._id } });
  const player = await Player.getOrCreateByUser(user._id);
  player.displayName = name;
  player.avatar = avatarKey;
  await player.save();

  audit(req, "admin_bot_create", { botId: String(user._id), name, personality, skill });
  await refreshCaches();
  res.status(201).json({ data: await serializeBot(user) });
});

const EDITABLE = ["name", "country", "profileImg"];
const BOT_EDITABLE = ["personality", "skill", "biography", "avatarKey", "themeKey", "enabled"];

exports.adminUpdateBot = asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, isBot: true });
  if (!user) throw new ApiError("Bot not found", 404);
  const b = req.body || {};

  if (typeof b.name === "string" && b.name.trim().length >= 2) user.name = b.name.trim();
  if (typeof b.country === "string") user.country = b.country;
  if (typeof b.avatarKey === "string") user.profileImg = b.avatarKey;
  if (b.language && ["ar", "en"].includes(b.language)) user.preferences.language = b.language;

  user.bot = user.bot || {};
  for (const k of BOT_EDITABLE) {
    if (typeof b[k] === "undefined") continue;
    if (k === "personality" && !PERSONALITIES.includes(b[k])) throw new ApiError("Invalid personality", 400);
    if (k === "skill" && !SKILLS.includes(b[k])) throw new ApiError("Invalid skill", 400);
    user.bot[k] = k === "biography" ? String(b[k]).slice(0, 300) : b[k];
  }
  await user.save();

  if (typeof b.balance !== "undefined") {
    await Wallet.updateOne({ user: user._id }, { $set: { balance: Math.max(0, parseInt(b.balance, 10) || 0) } });
  }
  void EDITABLE;
  audit(req, "admin_bot_update", { botId: String(user._id), fields: Object.keys(b) });
  await refreshCaches();
  res.json({ data: await serializeBot(user) });
});

exports.adminSetBotEnabled = asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, isBot: true });
  if (!user) throw new ApiError("Bot not found", 404);
  const enabled = req.body?.enabled !== false;
  user.bot = user.bot || {};
  user.bot.enabled = enabled;
  await user.save();
  audit(req, "admin_bot_set_enabled", { botId: String(user._id), enabled });
  await refreshCaches();
  res.json({ data: { id: String(user._id), enabled } });
});

exports.adminDeleteBot = asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, isBot: true });
  if (!user) throw new ApiError("Bot not found", 404);
  await Promise.all([
    Wallet.deleteOne({ user: user._id }),
    Player.deleteOne({ user: user._id }),
    User.deleteOne({ _id: user._id }),
  ]);
  audit(req, "admin_bot_delete", { botId: String(user._id) });
  await refreshCaches();
  res.json({ data: { status: "deleted" } });
});

// ─── global config ────────────────────────────────────────────────────────────
exports.adminGetConfig = asyncHandler(async (req, res) => {
  const s = await BotSettings.getDefaults();
  res.json({ data: s });
});

const CONFIG_KEYS = [
  "botsEnabled",
  "maxBotsPerTable",
  "minHumansToKeepBots",
  "defaultSkill",
  "chatFrequency",
  "emojiFrequency",
  "joinDelayMs",
  "leaveDelayMs",
  "thinkMinMs",
  "thinkMaxMs",
  "chatCooldownMs",
  "tableChatCooldownMs",
  "avatarCatalog",
];

exports.adminUpdateConfig = asyncHandler(async (req, res) => {
  const patch = req.body || {};
  const s = await BotSettings.getDefaults();
  for (const k of CONFIG_KEYS) if (typeof patch[k] !== "undefined") s[k] = patch[k];
  await s.save();
  botBehaviorService.applySettings(s);
  botChatService.applySettings(s);
  audit(req, "admin_bot_config_update", { fields: Object.keys(patch).filter((k) => CONFIG_KEYS.includes(k)) });
  res.json({ data: s });
});

exports.adminGetAvatarCatalog = asyncHandler(async (req, res) => {
  const s = await BotSettings.getDefaults();
  res.json({ data: s.avatarCatalog && s.avatarCatalog.length ? s.avatarCatalog : AVATAR_CATALOG });
});

exports.adminUpdateAvatarCatalog = asyncHandler(async (req, res) => {
  const list = Array.isArray(req.body?.catalog) ? req.body.catalog.map(String) : null;
  if (!list) throw new ApiError("catalog array required", 400);
  const s = await BotSettings.getDefaults();
  s.avatarCatalog = list;
  await s.save();
  audit(req, "admin_bot_avatar_catalog_update", { count: list.length });
  res.json({ data: s.avatarCatalog });
});
