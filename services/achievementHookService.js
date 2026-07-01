const Achievement = require("../models/achievementModel");
const Player = require("../models/playerModel");

const HAND_CATEGORY_ACHIEVEMENTS = {
  "Royal Flush": "ROYAL_FLUSH",
  "Straight Flush": "STRAIGHT_FLUSH",
  "Four of a Kind": "FOUR_OF_A_KIND",
  "Full House": "FULL_HOUSE",
};

async function unlockAchievement(userId, achievementCode) {
  const ach = await Achievement.findOne({ code: achievementCode.toUpperCase() });
  if (!ach) return null;
  const player = await Player.findOne({ user: userId });
  if (!player) return null;
  const has = (player.achievements || []).some(
    (a) => String(a.achievement) === String(ach._id)
  );
  if (has) return null;
  player.achievements = player.achievements || [];
  player.achievements.push({ achievement: ach._id, unlockedAt: new Date() });
  await player.save();
  return ach;
}

async function onHandCompleted({ handId, gameType, seats, winners, handCategory, actions }) {
  for (const w of winners || []) {
    const uid = w.user || w.userId;
    if (!uid) continue;
    await unlockAchievement(uid, "FIRST_WIN").catch(() => {});
    const wins = (w.share || 0) > 0;
    if (wins) await unlockAchievement(uid, "HAND_WON").catch(() => {});
  }

  if (handCategory && HAND_CATEGORY_ACHIEVEMENTS[handCategory]) {
    for (const w of winners || []) {
      const uid = w.user || w.userId;
      if (uid) await unlockAchievement(uid, HAND_CATEGORY_ACHIEVEMENTS[handCategory]).catch(() => {});
    }
  }

  const reasonFold = (actions || []).filter((a) => a.type === "fold").length;
  const aliveAtEnd = (seats || []).filter((s) => !s.folded).length;
  if (reasonFold > 0 && aliveAtEnd === 1 && winners?.length === 1) {
    const uid = winners[0].user || winners[0].userId;
    if (uid) await unlockAchievement(uid, "WIN_WITHOUT_SHOWDOWN").catch(() => {});
  }
}

module.exports = { onHandCompleted, unlockAchievement };
