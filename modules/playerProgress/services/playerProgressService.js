"use strict";

const { XP_PER_LEVEL } = require("../config/playerProgressConfig");
const repository = require("../repositories/playerProgressRepository");
const PlayerXpHistory = require("../models/playerXpHistoryModel");
const { publish } = require("../../../domain/events/domainEventBus");
const Events = require("../../../domain/events/eventTypes");

async function getProgress(userId) {
  const player = await repository.getOrCreatePlayer(userId);
  const s = player.stats || {};
  const experience = s.experience || 0;
  const level = s.level || 1;
  return {
    level,
    experience,
    xpPerLevel: XP_PER_LEVEL,
    xpInLevel: experience % XP_PER_LEVEL,
    xpProgress: (experience % XP_PER_LEVEL) / XP_PER_LEVEL,
  };
}

async function grantXp(userId, amount, { source = "unknown", sourceId = "" } = {}) {
  const xpAdded = Math.max(0, Math.floor(Number(amount) || 0));
  if (!userId || xpAdded <= 0) {
    return { level: 1, experience: 0, levelsGained: 0, xpAdded: 0, duplicate: false };
  }

  const sid = String(sourceId || "");
  if (sid) {
    const exists = await PlayerXpHistory.exists({ userId, source, sourceId: sid });
    if (exists) {
      const player = await repository.getOrCreatePlayer(userId);
      return {
        level: player.stats?.level || 1,
        experience: player.stats?.experience || 0,
        levelsGained: 0,
        xpAdded: 0,
        duplicate: true,
      };
    }
  }

  const player = await repository.getOrCreatePlayer(userId);
  const levelBefore = player.stats.level || 1;
  const xpBefore = player.stats.experience || 0;

  player.stats.experience = xpBefore + xpAdded;
  let levelsGained = 0;

  while (player.stats.experience >= XP_PER_LEVEL) {
    player.stats.experience -= XP_PER_LEVEL;
    player.stats.level = (player.stats.level || 1) + 1;
    levelsGained += 1;
  }

  await repository.savePlayer(player);

  const levelAfter = player.stats.level || 1;
  const xpAfter = player.stats.experience || 0;

  await repository.appendXpHistory({
    userId,
    source,
    sourceId: String(sourceId || ""),
    xpBefore,
    xpAdded,
    xpAfter,
    levelBefore,
    levelAfter,
  });

  publish(Events.PLAYER_GAINED_XP, {
    userId: String(userId),
    source,
    sourceId,
    xpAdded,
    level: levelAfter,
    experience: xpAfter,
  });

  if (levelsGained > 0) {
    publish(Events.PLAYER_LEVEL_UP, {
      userId: String(userId),
      levelBefore,
      levelAfter,
      levelsGained,
      source,
    });
  }

  return {
    level: levelAfter,
    experience: xpAfter,
    levelsGained,
    xpAdded,
  };
}

module.exports = {
  getProgress,
  grantXp,
  XP_PER_LEVEL,
};
