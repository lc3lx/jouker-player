const path = require("path");
const fs = require("fs");
const asyncHandler = require("express-async-handler");
const { v4: uuidv4 } = require("uuid");
const sharp = require("sharp");

const ApiError = require("../utils/apiError");
const factory = require("./handlersFactory");

const Player = require("../models/playerModel");
const GameSession = require("../models/gameSessionModel");
const GameItem = require("../models/gameItemModel");
const Achievement = require("../models/achievementModel");
const Wallet = require("../models/walletModel");

const { uploadSingleImage } = require("../middlewares/uploadImageMiddleware");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Upload single image for game item
exports.uploadGameItemImage = uploadSingleImage("image");

// Image processing for game item
exports.resizeGameItemImage = asyncHandler(async (req, res, next) => {
  if (!req.file) return next();
  const uploadsDir = path.join("uploads", "game-items");
  ensureDir(uploadsDir);
  const filename = `game-item-${uuidv4()}-${Date.now()}.jpeg`;

  await sharp(req.file.buffer)
    .resize(600, 600)
    .toFormat("jpeg")
    .jpeg({ quality: 90 })
    .toFile(path.join(uploadsDir, filename));

  req.body.image = filename;
  next();
});

// ---------- Profile ----------
exports.getProfile = asyncHandler(async (req, res) => {
  const player = await Player.getOrCreateByUser(req.user._id);
  res.status(200).json({ data: player });
});

exports.updateProfile = asyncHandler(async (req, res) => {
  const player = await Player.getOrCreateByUser(req.user._id);
  if (typeof req.body.displayName !== "undefined") {
    player.displayName = req.body.displayName;
  }
  if (typeof req.body.avatar !== "undefined") {
    player.avatar = req.body.avatar;
  }
  await player.save();
  res.status(200).json({ data: player });
});

// ---------- Leaderboard ----------
exports.getLeaderboard = asyncHandler(async (req, res) => {
  const type = ["totalScore", "bestScore"].includes(req.query.type)
    ? req.query.type
    : "totalScore";
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const players = await Player.find()
    .sort({ [`stats.${type}`]: -1 })
    .limit(limit)
    .select("displayName stats");
  res.status(200).json({ results: players.length, data: players });
});

// ---------- Sessions ----------
exports.startSession = asyncHandler(async (req, res) => {
  const player = await Player.getOrCreateByUser(req.user._id);
  const session = await GameSession.create({
    player: player._id,
    status: "active",
    metadata: req.body.metadata || {},
    startedAt: new Date(),
  });
  res.status(201).json({ data: session });
});

exports.finishSession = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const { score, durationSec, won, tournament } = req.body;

  const session = await GameSession.findById(id).populate("player");
  if (!session) return next(new ApiError(`No session for id ${id}`, 404));

  // Ensure session belongs to the current user
  const player = await Player.getOrCreateByUser(req.user._id);
  if (String(session.player._id) !== String(player._id)) {
    return next(new ApiError("Not allowed to modify this session", 403));
  }

  if (session.status === "completed") {
    return next(new ApiError("Session already completed", 400));
  }

  session.status = "completed";
  session.score = Math.max(0, Number(score) || 0);
  session.durationSec = Math.max(0, Number(durationSec) || 0);
  session.endedAt = new Date();
  if (typeof won !== "undefined") {
    session.won = !!won;
  }
  if (tournament) {
    session.tournament = tournament;
  }
  await session.save();

  // Update player stats
  player.stats.totalScore += session.score;
  player.stats.gamesPlayed += 1;
  player.stats.totalPlayTimeSec += session.durationSec;
  if (session.score > player.stats.bestScore) {
    player.stats.bestScore = session.score;
  }
  if (session.won) {
    player.stats.wins += 1;
  }
  await player.save();

  res.status(200).json({ data: session, player });
});

exports.listMySessions = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page || "1", 10);
  const limit = parseInt(req.query.limit || "10", 10);
  const skip = (page - 1) * limit;
  const player = await Player.getOrCreateByUser(req.user._id);
  const total = await GameSession.countDocuments({ player: player._id });
  const sessions = await GameSession.find({ player: player._id })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
  res.status(200).json({
    results: sessions.length,
    paginationResult: {
      currentPage: page,
      limit,
      numberOfPages: Math.ceil(total / limit),
      next: page * limit < total ? page + 1 : null,
    },
    data: sessions,
  });
});

// ---------- Items ----------
exports.getGameItems = factory.getAll(GameItem);
exports.getGameItem = factory.getOne(GameItem);
exports.createGameItem = factory.createOne(GameItem);
exports.updateGameItem = factory.updateOne(GameItem);
exports.deleteGameItem = factory.deleteOne(GameItem);

exports.buyItem = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const quantity = Math.max(1, parseInt(req.body.quantity || "1", 10));

  const item = await GameItem.findById(id);
  if (!item || !item.isActive) return next(new ApiError("Item not available", 404));
  if (item.stock < quantity) return next(new ApiError("Not enough stock", 400));

  // Get wallet
  let wallet = await Wallet.findOne({ user: req.user._id });
  if (!wallet) {
    wallet = await Wallet.create({ user: req.user._id });
  }

  const totalCost = item.price * quantity;
  if (!wallet.hasSufficientBalance(totalCost)) {
    return next(new ApiError("Insufficient wallet balance", 400));
  }

  // Debit wallet
  await wallet.addTransaction(
    "debit",
    totalCost,
    `Purchased item: ${item.name} x${quantity}`
  );

  // Decrement stock
  item.stock -= quantity;
  await item.save();

  // Update player inventory
  const player = await Player.getOrCreateByUser(req.user._id);
  const idx = player.inventory.findIndex((e) => String(e.item) === String(item._id));
  if (idx > -1) {
    player.inventory[idx].quantity += quantity;
  } else {
    player.inventory.push({ item: item._id, quantity });
  }
  await player.save();

  res.status(200).json({
    status: "success",
    message: "Item purchased successfully",
    data: { item, quantity, walletBalance: wallet.balance, player },
  });
});

exports.listInventory = asyncHandler(async (req, res) => {
  const player = await Player.getOrCreateByUser(req.user._id);
  await player.populate({ path: "inventory.item" });
  res.status(200).json({ results: player.inventory.length, data: player.inventory });
});

// Use an item from inventory (consume one quantity)
exports.useItem = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const player = await Player.getOrCreateByUser(req.user._id);
  await player.populate({ path: "inventory.item" });

  const idx = player.inventory.findIndex((e) => String(e.item._id || e.item) === String(id));
  if (idx === -1 || (player.inventory[idx].quantity || 0) <= 0) {
    return next(new ApiError("Item not found in your inventory", 400));
  }

  // Consume one unit
  player.inventory[idx].quantity -= 1;
  if (player.inventory[idx].quantity <= 0) {
    player.inventory.splice(idx, 1);
  }
  await player.save();

  res.status(200).json({ status: "success", data: { inventory: player.inventory } });
});

// ---------- Achievements ----------
exports.getAchievements = factory.getAll(Achievement);
exports.getAchievement = factory.getOne(Achievement);
exports.createAchievement = factory.createOne(Achievement);
exports.updateAchievement = factory.updateOne(Achievement);
exports.deleteAchievement = factory.deleteOne(Achievement);

exports.unlockAchievement = asyncHandler(async (req, res, next) => {
  const code = String(req.params.code || "").toUpperCase();
  const ach = await Achievement.findOne({ code, isActive: true });
  if (!ach) return next(new ApiError("Achievement not found", 404));

  const player = await Player.getOrCreateByUser(req.user._id);
  const already = player.achievements.find((a) => String(a) === String(ach._id));
  if (!already) {
    player.achievements.push(ach._id);
    // Reward: add experience points
    player.stats.experience += ach.points || 0;
    // Simple level up rule: 100 xp per level
    while (player.stats.experience >= player.stats.level * 100) {
      player.stats.experience -= player.stats.level * 100;
      player.stats.level += 1;
    }
    await player.save();
  }

  res.status(200).json({ status: "success", data: { player, achievement: ach } });
});

// Get my achievements
exports.getMyAchievements = asyncHandler(async (req, res) => {
  const player = await Player.getOrCreateByUser(req.user._id);
  await player.populate({ path: "achievements" });
  res
    .status(200)
    .json({ results: player.achievements.length, data: player.achievements });
});
