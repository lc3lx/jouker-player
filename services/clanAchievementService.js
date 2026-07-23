const Clan = require("../models/clanModel");
const ClanAchievementDef = require("../models/clanAchievementDefModel");
const ClanAchievement = require("../models/clanAchievementModel");
const { withMongoTransaction } = require("./walletLedgerService");
const clanTreasuryService = require("./clanTreasuryService");
const clanRealtime = require("./clanRealtime");
const chatService = require("./chatService");
const logger = require("../utils/logger");

/** Read a criterion metric from clan.stats first, then top-level clan fields. */
function metricValue(clan, metric) {
  if (clan.stats && typeof clan.stats[metric] !== "undefined") return Number(clan.stats[metric]) || 0;
  if (typeof clan[metric] !== "undefined") return Number(clan[metric]) || 0;
  return 0;
}

function satisfies(value, op, threshold) {
  const t = Number(threshold) || 0;
  switch (op) {
    case "gt":
      return value > t;
    case "gte":
      return value >= t;
    case "lt":
      return value < t;
    case "lte":
      return value <= t;
    case "eq":
      return value === t;
    default:
      return value >= t;
  }
}

/**
 * Evaluate all active achievement definitions against a clan's live stats and
 * award any newly-satisfied ones (idempotent via the unique (clan,defKey) index).
 * Data-driven: new achievements require only a new ClanAchievementDef document.
 */
async function evaluateClan(clanId) {
  const clan = await Clan.findById(clanId).lean();
  if (!clan || clan.status !== "active") return [];

  const [defs, earnedKeys] = await Promise.all([
    ClanAchievementDef.find({ active: true }).lean(),
    ClanAchievement.find({ clan: clanId }).distinct("defKey"),
  ]);
  const earned = new Set(earnedKeys.map(String));
  const awarded = [];

  for (const def of defs) {
    if (earned.has(def.key)) continue;
    const crit = def.criteria || {};
    const value = metricValue(clan, crit.metric);
    if (!satisfies(value, crit.op, crit.threshold)) continue;

    try {
      await ClanAchievement.create({ clan: clanId, defKey: def.key, metaValue: value });
    } catch (e) {
      // Duplicate → already awarded concurrently; skip.
      if (e && (e.code === 11000 || e.code === 11001)) continue;
      logger.warn("clan_achievement_award_failed", { defKey: def.key, reason: e?.message });
      continue;
    }

    // Grant rewards (treasury coins + clan xp) atomically.
    const rewardCoins = Math.max(0, Math.floor(def.rewardCoins || 0));
    const rewardXp = Math.max(0, Math.floor(def.rewardXp || 0));
    if (rewardCoins > 0 || rewardXp > 0) {
      try {
        await withMongoTransaction(async (session) => {
          if (rewardCoins > 0) {
            await clanTreasuryService.creditTreasuryInSession(session, clanId, rewardCoins, {
              type: "event",
              meta: { source: "achievement", defKey: def.key },
            });
          }
          if (rewardXp > 0) {
            await Clan.updateOne({ _id: clanId }, { $inc: { xp: rewardXp } }, session ? { session } : {});
          }
        });
      } catch (e) {
        logger.warn("clan_achievement_reward_failed", { defKey: def.key, reason: e?.message });
      }
    }

    awarded.push({ key: def.key, title: def.title, rewardCoins, rewardXp });
    clanRealtime.emitToClan(clanId, "clan:achievement", { key: def.key, title: def.title });
    chatService
      .sendSystemMessage({
        channel: "clan",
        channelId: clanId,
        actorId: clan.owner,
        body: `🏅 إنجاز جديد: ${def.title}`,
        meta: { event: "achievement", defKey: def.key },
      })
      .catch(() => {});
  }

  return awarded;
}

async function listAchievements(clanId) {
  const clan = await Clan.findById(clanId).lean();
  if (!clan) return { earned: [], locked: [] };
  const [defs, earned] = await Promise.all([
    ClanAchievementDef.find({ active: true }).sort({ sortOrder: 1 }).lean(),
    ClanAchievement.find({ clan: clanId }).lean(),
  ]);
  const earnedMap = new Map(earned.map((e) => [e.defKey, e]));
  const out = { earned: [], locked: [] };
  for (const def of defs) {
    const got = earnedMap.get(def.key);
    const crit = def.criteria || {};
    const entry = {
      key: def.key,
      title: def.title,
      description: def.description,
      icon: def.icon,
      rewardCoins: def.rewardCoins,
      rewardXp: def.rewardXp,
      metric: crit.metric,
      threshold: crit.threshold,
      current: metricValue(clan, crit.metric),
    };
    if (got) out.earned.push({ ...entry, awardedAt: got.awardedAt });
    else out.locked.push(entry);
  }
  return out;
}

module.exports = { evaluateClan, listAchievements, metricValue };
