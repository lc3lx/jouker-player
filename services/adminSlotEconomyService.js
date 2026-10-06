"use strict";

/**
 * Admin: slot economy (Poseidon / Zeus / Zenobia).
 *
 * Read: realized results per game and time window, the profile ladder, drift
 * alerts, change history. Write: pick a calibrated profile, switch the
 * profile economy on, open/close play and purchases, bet limits. Every write
 * needs a reason and is recorded in the audit chain.
 *
 * There is intentionally no per-player control here: the house edge comes
 * only from the disclosed, global profile.
 */

const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const registry = require("../games/slotProfiles/registry");
const settingsService = require("./slotEconomySettingsService");
const auditService = require("./auditService");

const GAME_NAMES = { poseidon: "بوسيدون", zeus: "زيوس", zenobia: "زنوبيا" };
const WINDOWS = [["24h", 1], ["7d", 7], ["30d", 30], ["all", null]];
const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_EVENT = "slot_economy.settings.update";

const SUM_FIELDS = [
  "paidSpins", "paidBet", "paidBetSq", "paidWin", "paidHits", "plaqueSpins", "naturalTriggers",
  "jackpotTriggers", "naturalSpins", "naturalWin", "buys", "buySpend", "buySpins", "buyWin",
  "superBuys", "superSpend", "superSpins", "superWin", "jackpotPaidBase", "jackpotPaidBuy",
  "jackpotPaidSuper", "jackpotRounds", "cappedRounds",
];

function assertGame(game) {
  if (!registry.GAMES.includes(game)) throw new ApiError("Unknown slot game", 404);
}

async function sumStats(match) {
  const mongoose = require("mongoose");
  if (mongoose.connection?.readyState !== 1) {
    // No database (tests / tools): fold the in-memory telemetry instead.
    const rows = require("../games/utils/slotEconomyStats")._memoryRows().filter((r) =>
      r.game === match.game
      && (!match.profileId || r.profileId === match.profileId)
      && (!match.since || r.hour >= match.since));
    const totals = Object.fromEntries(SUM_FIELDS.map((f) => [f, 0]));
    let maxWinX = 0;
    for (const r of rows) {
      for (const f of SUM_FIELDS) totals[f] += r[f] || 0;
      maxWinX = Math.max(maxWinX, r.maxWinX || 0);
    }
    return { ...totals, maxWinX };
  }
  const SlotEconomyStat = require("../models/slotEconomyStatModel");
  const filter = { game: match.game };
  if (match.profileId) filter.profileId = match.profileId;
  if (match.since) filter.hour = { $gte: match.since };
  const group = { _id: null, maxWinX: { $max: "$maxWinX" } };
  for (const f of SUM_FIELDS) group[f] = { $sum: `$${f}` };
  const [row] = await SlotEconomyStat.aggregate([{ $match: filter }, { $group: group }]);
  const totals = Object.fromEntries(SUM_FIELDS.map((f) => [f, row?.[f] || 0]));
  return { ...totals, maxWinX: row?.maxWinX || 0 };
}

const ratio = (a, b) => (b > 0 ? a / b : null);

/** Realized money and rate metrics from summed hourly totals. */
function metrics(t) {
  const baseReturn = t.paidWin + t.naturalWin + t.jackpotPaidBase;
  const buyReturn = t.buyWin + t.jackpotPaidBuy;
  const superReturn = t.superWin + t.jackpotPaidSuper;
  const turnover = t.paidBet + t.buySpend + t.superSpend;
  const returned = baseReturn + buyReturn + superReturn;
  return {
    turnover,
    returned,
    houseProfit: turnover - returned,
    rtp: ratio(returned, turnover),
    baseRtp: ratio(baseReturn, t.paidBet),
    buyRtp: ratio(buyReturn, t.buySpend),
    superRtp: ratio(superReturn, t.superSpend),
    paidSpins: t.paidSpins,
    freeSpins: t.naturalSpins + t.buySpins + t.superSpins,
    buys: t.buys,
    superBuys: t.superBuys,
    buySpend: t.buySpend + t.superSpend,
    jackpotsPaid: t.jackpotRounds,
    jackpotPaid: t.jackpotPaidBase + t.jackpotPaidBuy + t.jackpotPaidSuper,
    hitRate: ratio(t.paidHits, t.paidSpins),
    plaqueRate: ratio(t.plaqueSpins, t.paidSpins),
    freeSpinsOneIn: t.naturalTriggers ? t.paidSpins / t.naturalTriggers : null,
    jackpotOneIn: t.jackpotTriggers ? t.paidSpins / t.jackpotTriggers : null,
    cappedRounds: t.cappedRounds,
    maxWinX: t.maxWinX,
  };
}

/**
 * Drift alerts for the active profile, from stats gathered since it became
 * active. Rates (hit, plaque, bonus, jackpot) are tight binomial/Poisson
 * checks that expose a misconfiguration within hours; realized RTP is a
 * funnel check against the profile's measured per-spin spread.
 */
function alerts(profile, t) {
  const out = [];
  const n = t.paidSpins;
  const binomial = (code, label, observed, p, minN) => {
    if (n < minN || !(p > 0 && p < 1)) return;
    const z = (observed / n - p) / Math.sqrt((p * (1 - p)) / n);
    if (Math.abs(z) > 5) {
      out.push({ severity: "critical", code, z: Number(z.toFixed(2)),
        message: `${label}: ${(observed / n * 100).toFixed(2)}% مقابل ${(p * 100).toFixed(2)}% المتوقع` });
    }
  };
  const poisson = (code, label, observed, p) => {
    const expected = n * p;
    if (expected < 20) return;
    const z = (observed - expected) / Math.sqrt(expected);
    if (Math.abs(z) > 5) {
      out.push({ severity: "critical", code, z: Number(z.toFixed(2)),
        message: `${label}: ${observed} مقابل ${expected.toFixed(0)} متوقع` });
    }
  };
  binomial("hit_rate_drift", "نسبة اللفات الرابحة", t.paidHits, profile.measured.hitRate, 2000);
  if (profile.game !== "zenobia") {
    // One scheduled plaque per spin: its presence is exact by design.
    const presence = profile.params.plaques.base.reduce((a, b) => a + b, 0) / 100;
    binomial("plaque_rate_drift", "ظهور المضاعف", t.plaqueSpins, presence, 2000);
  }
  poisson("bonus_rate_drift", "البونص المجاني", t.naturalTriggers, profile.params.naturalBonusProbability);
  poisson("jackpot_rate_drift", "الجاكبوت", t.jackpotTriggers, profile.params.jackpot.win);

  if (t.paidBet > 0 && t.paidBetSq > 0) {
    const nEff = (t.paidBet * t.paidBet) / t.paidBetSq;
    const baseRtp = (t.paidWin + t.naturalWin + t.jackpotPaidBase) / t.paidBet;
    const z = (baseRtp - profile.targetRtp) / (profile.measured.sdPerSpin / Math.sqrt(nEff));
    if (nEff >= 5000 && Math.abs(z) > 4) {
      out.push({ severity: z > 0 ? "critical" : "warning", code: "rtp_drift", z: Number(z.toFixed(2)),
        message: `العائد الفعلي ${(baseRtp * 100).toFixed(2)}% خارج النطاق المتوقع حول ${(profile.targetRtp * 100).toFixed(0)}%` });
    }
  }
  for (const [kind, buys, spend, ret, cost, ci, rtpLabel] of [
    ["standard", t.buys, t.buySpend, t.buyWin + t.jackpotPaidBuy, profile.buy.standardCost, profile.measured.buy.standardEvCi95X, "شراء البونص"],
    ["super", t.superBuys, t.superSpend, t.superWin + t.jackpotPaidSuper, profile.buy.superCost, profile.measured.buy.superEvCi95X, "السوبر بونص"],
  ]) {
    if (buys < 200 || !(spend > 0)) continue;
    const sdPerBuy = ((ci / 1.96) * Math.sqrt(profile.measured.sims?.sessions || 600000)) / cost;
    const realized = ret / spend;
    const z = (realized - profile.targetRtp) / (sdPerBuy / Math.sqrt(buys));
    if (Math.abs(z) > 4) {
      out.push({ severity: z > 0 ? "critical" : "warning", code: `${kind}_buy_rtp_drift`, z: Number(z.toFixed(2)),
        message: `عائد ${rtpLabel} الفعلي ${(realized * 100).toFixed(1)}% بعيد عن ${(profile.targetRtp * 100).toFixed(0)}%` });
    }
  }
  return out;
}

function profileSummary(profile) {
  return {
    id: profile.id,
    label: profile.label,
    status: profile.status,
    verified: registry.isVerified(profile.id),
    targetRtp: profile.targetRtp,
    houseEdge: Number((1 - profile.targetRtp).toFixed(4)),
    buy: { ...profile.buy },
    measured: {
      rtp: profile.measured.rtp,
      rtpMonteCarlo: profile.measured.rtpMonteCarlo,
      rtpMonteCarloCi95: profile.measured.rtpMonteCarloCi95,
      hitRate: profile.measured.hitRate,
      winAtLeastBetRate: profile.measured.winAtLeastBetRate,
      plaqueVisibleRate: profile.measured.plaqueVisibleRate,
      freeSpinsOneIn: profile.measured.freeSpinsOneIn,
      jackpotOneIn: profile.measured.jackpotOneIn,
      standardBuyRtp: profile.measured.buy.standardRtp,
      superBuyRtp: profile.measured.buy.superRtp,
      parts: profile.measured.parts,
    },
    rules: { ...profile.rules },
    generatedAt: profile.measured.generatedAt,
  };
}

async function legacySessionCount(game) {
  const mongoose = require("mongoose");
  if (mongoose.connection?.readyState !== 1) return 0;
  const current = registry.ENGINE_VERSIONS[game];
  if (game === "zeus") {
    const Model = require("../models/kingArthBonusSessionModel");
    return Model.countDocuments({
      "session.remaining": { $gt: 0 },
      $or: [{ "session.economyVersion": { $lt: current } }, { "session.economyVersion": null }],
    });
  }
  const Model = require(`../models/${game}BonusSessionModel`);
  return Model.countDocuments({
    freeSpinsRemaining: { $gt: 0 },
    $or: [{ economyVersion: { $lt: current } }, { economyVersion: null }],
  });
}

async function gameOverview(game, now = Date.now()) {
  const settings = settingsService.getSettings(game);
  const activeId = settingsService.activeProfileId(game, now);
  const active = activeId ? registry.getProfile(activeId) : null;
  const windows = {};
  for (const [key, days] of WINDOWS) {
    windows[key] = metrics(await sumStats({ game, since: days ? new Date(now - days * DAY_MS) : null }));
  }
  let current = null;
  if (settings.economyLive && active) {
    const since = settings.pending?.effectiveAt && settings.pending.profileId === activeId
      ? settings.pending.effectiveAt
      : settings.profileChangedAt;
    const totals = await sumStats({ game, profileId: active.id, since: since || null });
    current = { since, metrics: metrics(totals), alerts: alerts(active, totals) };
  }
  return {
    game,
    name: GAME_NAMES[game],
    settings,
    activeProfile: active ? profileSummary(active) : null,
    windows,
    current,
    legacySessions: await legacySessionCount(game),
  };
}

exports.getOverview = asyncHandler(async (req, res) => {
  const games = [];
  for (const game of registry.GAMES) games.push(await gameOverview(game));
  res.status(200).json({ status: "success", data: { games, generatedAt: new Date().toISOString() } });
});

exports.listProfiles = asyncHandler(async (req, res) => {
  const { game } = req.params;
  assertGame(game);
  res.status(200).json({
    status: "success",
    data: registry.listProfiles(game).map(profileSummary),
  });
});

exports.timeseries = asyncHandler(async (req, res) => {
  const { game } = req.params;
  assertGame(game);
  const days = Math.min(90, Math.max(1, parseInt(req.query.days || "14", 10)));
  const since = new Date(Date.now() - days * DAY_MS);
  const mongoose = require("mongoose");
  let rows = [];
  if (mongoose.connection?.readyState === 1) {
    const SlotEconomyStat = require("../models/slotEconomyStatModel");
    const group = { _id: { $dateToString: { format: "%Y-%m-%d", date: "$hour" } } };
    for (const f of SUM_FIELDS) group[f] = { $sum: `$${f}` };
    group.maxWinX = { $max: "$maxWinX" };
    rows = await SlotEconomyStat.aggregate([
      { $match: { game, hour: { $gte: since } } },
      { $group: group },
      { $sort: { _id: 1 } },
    ]);
  }
  res.status(200).json({
    status: "success",
    data: rows.map((r) => ({ day: r._id, ...metrics(r) })),
  });
});

exports.updateSettings = asyncHandler(async (req, res) => {
  const { game } = req.params;
  assertGame(game);
  const { reason, revision, ...patch } = req.body || {};
  const { before, after } = await settingsService.updateSettings(game, patch, {
    actorId: req.user?._id || null,
    reason,
    expectedRevision: revision === undefined ? undefined : Number(revision),
  });
  await auditService.logEvent({
    event: AUDIT_EVENT,
    actor: req.user?._id || null,
    ip: req.ip || null,
    userAgent: req.headers?.["user-agent"] || null,
    meta: {
      game,
      reason: String(reason).trim(),
      patch,
      before,
      after,
      adminName: req.user?.name || null,
    },
  });
  res.status(200).json({ status: "success", data: await gameOverview(game) });
});

exports.auditTrail = asyncHandler(async (req, res) => {
  const AuditLog = require("../models/auditLogModel");
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const filter = { event: AUDIT_EVENT };
  if (req.query.game) filter["meta.game"] = String(req.query.game);
  const rows = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit)
    .populate("actor", "name email").lean();
  res.status(200).json({
    status: "success",
    data: rows.map((r) => ({
      id: String(r._id),
      at: r.createdAt,
      game: r.meta?.game,
      actor: r.actor ? { id: String(r.actor._id), name: r.actor.name || r.meta?.adminName || null } : null,
      reason: r.meta?.reason,
      patch: r.meta?.patch,
      before: r.meta?.before,
      after: r.meta?.after,
    })),
  });
});

module.exports._internal = { metrics, alerts, profileSummary, sumStats, gameOverview };
