"use strict";

const Player = require("../../../models/playerModel");
const PlayerXpHistory = require("../models/playerXpHistoryModel");

async function getOrCreatePlayer(userId) {
  return Player.getOrCreateByUser(userId);
}

async function savePlayer(player) {
  await player.save();
  return player;
}

async function appendXpHistory(row) {
  return PlayerXpHistory.create(row);
}

async function listXpHistory(userId, { page = 1, limit = 50 } = {}) {
  const skip = (Math.max(page, 1) - 1) * Math.min(limit, 100);
  const [rows, total] = await Promise.all([
    PlayerXpHistory.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Math.min(limit, 100))
      .lean(),
    PlayerXpHistory.countDocuments({ userId }),
  ]);
  return { rows, total, page: Math.max(page, 1), limit: Math.min(limit, 100) };
}

module.exports = {
  getOrCreatePlayer,
  savePlayer,
  appendXpHistory,
  listXpHistory,
};
