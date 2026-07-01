const Achievement = require("../models/achievementModel");
const Player = require("../models/playerModel");

const HAND_CATEGORY_ACHIEVEMENTS = {
  "Royal Flush": "royal_flush",
  "Straight Flush": "straight_flush",
  "Four of a Kind": "four_of_a_kind",
  "Full House": "full_house",
};

async function unlockAchievement(userId, achievementKey) {
  const ach = await Achievement.findOne({ key: achievementKey });
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
    await unlockAchievement(uid, "first_win").catch(() => {});
    const wins = (w.share || 0) > 0;
    if (wins) await unlockAchievement(uid, "hand_won").catch(() => {});
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
    if (uid) await unlockAchievement(uid, "win_without_showdown").catch(() => {});
  }
}

module.exports = { onHandCompleted, unlockAchievement };
