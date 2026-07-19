"use strict";

/**
 * Economy analytics — read-only aggregations for the future Admin Dashboard.
 *
 * Source of truth is `InteractionUsageDaily` (per item/day counters), which
 * captures FREE consumable sends that never hit the wallet ledger, plus purchases
 * and Coin revenue. This makes most-sent / most-received / popularity accurate,
 * and daily/weekly/monthly spending a cheap rollup. Coins only — no fiat.
 */

const InteractionUsageDaily = require("../models/interactionUsageDailyModel");

const COLLECTION = "interactionitems"; // mongoose pluralized name for InteractionItem

function dayKey(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/** Default window: last `days` days (inclusive), as YYYY-MM-DD string bounds. */
function resolveRange({ from, to, days = 30 } = {}) {
  const toDay = to ? String(to).slice(0, 10) : dayKey(Date.now());
  const fromDay = from
    ? String(from).slice(0, 10)
    : dayKey(Date.now() - (days - 1) * 86400_000);
  return { from: fromDay, to: toDay };
}

function rangeMatch(range) {
  return { day: { $gte: range.from, $lte: range.to } };
}

/** Enrich a grouped-by-itemKey pipeline with item name/icon/category. */
function enrichItemStage() {
  return [
    { $lookup: { from: COLLECTION, localField: "_id", foreignField: "key", as: "item" } },
    { $addFields: { item: { $arrayElemAt: ["$item", 0] } } },
    {
      $project: {
        _id: 0,
        itemKey: "$_id",
        name: "$item.name",
        icon: "$item.icon",
        category: "$item.category",
        rarity: "$item.rarity",
        sends: 1, receives: 1, purchases: 1, revenue: 1,
      },
    },
  ];
}

async function _topBy(metric, opts = {}) {
  const range = resolveRange(opts);
  const limit = Math.min(100, Math.max(1, parseInt(opts.limit || "10", 10)));
  return InteractionUsageDaily.aggregate([
    { $match: rangeMatch(range) },
    {
      $group: {
        _id: "$itemKey",
        sends: { $sum: "$sends" },
        receives: { $sum: "$receives" },
        purchases: { $sum: "$purchases" },
        revenue: { $sum: "$revenue" },
      },
    },
    { $sort: { [metric]: -1 } },
    { $limit: limit },
    ...enrichItemStage(),
  ]);
}

const mostPurchased = (opts) => _topBy("purchases", opts);
const mostSent = (opts) => _topBy("sends", opts);
const mostReceived = (opts) => _topBy("receives", opts);
const revenueByItem = (opts) => _topBy("revenue", opts);
const popularity = (opts) => _topBy("sends", opts); // popularity ≈ total sends

/** Coin-spending time series at day / week / month granularity. */
async function spending(opts = {}) {
  const range = resolveRange({ ...opts, days: opts.days || 90 });
  const granularity = ["day", "week", "month"].includes(opts.granularity) ? opts.granularity : "day";

  let groupId;
  let pre = [];
  if (granularity === "day") {
    groupId = "$day";
  } else if (granularity === "month") {
    groupId = { $substrBytes: ["$day", 0, 7] }; // YYYY-MM
  } else {
    // week → derive ISO year-week from the day string
    pre = [{ $addFields: { _d: { $dateFromString: { dateString: "$day" } } } }];
    groupId = { $concat: [
      { $toString: { $isoWeekYear: "$_d" } }, "-W",
      { $toString: { $isoWeek: "$_d" } },
    ] };
  }

  const rows = await InteractionUsageDaily.aggregate([
    { $match: rangeMatch(range) },
    ...pre,
    {
      $group: {
        _id: groupId,
        revenue: { $sum: "$revenue" },
        purchases: { $sum: "$purchases" },
        sends: { $sum: "$sends" },
        receives: { $sum: "$receives" },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, bucket: "$_id", revenue: 1, purchases: 1, sends: 1, receives: 1 } },
  ]);
  return { granularity, range, series: rows };
}

/** Totals + top lists for a single dashboard call. */
async function overview(opts = {}) {
  const range = resolveRange(opts);
  const [totalsAgg, purchased, sent, received, revenue] = await Promise.all([
    InteractionUsageDaily.aggregate([
      { $match: rangeMatch(range) },
      {
        $group: {
          _id: null,
          sends: { $sum: "$sends" },
          receives: { $sum: "$receives" },
          purchases: { $sum: "$purchases" },
          revenue: { $sum: "$revenue" },
        },
      },
    ]),
    mostPurchased({ ...opts, limit: 5 }),
    mostSent({ ...opts, limit: 5 }),
    mostReceived({ ...opts, limit: 5 }),
    revenueByItem({ ...opts, limit: 5 }),
  ]);

  const totals = totalsAgg[0] || { sends: 0, receives: 0, purchases: 0, revenue: 0 };
  delete totals._id;
  return { range, totals, mostPurchased: purchased, mostSent: sent, mostReceived: received, revenueByItem: revenue };
}

/** Full stats for one item over the window. */
async function itemStats(itemKey, opts = {}) {
  const range = resolveRange(opts);
  const rows = await InteractionUsageDaily.aggregate([
    { $match: { itemKey: String(itemKey), ...rangeMatch(range) } },
    {
      $group: {
        _id: null,
        sends: { $sum: "$sends" },
        receives: { $sum: "$receives" },
        purchases: { $sum: "$purchases" },
        revenue: { $sum: "$revenue" },
      },
    },
  ]);
  const totals = rows[0] || { sends: 0, receives: 0, purchases: 0, revenue: 0 };
  delete totals._id;
  return { itemKey: String(itemKey), range, totals };
}

module.exports = {
  overview,
  mostPurchased, mostSent, mostReceived, revenueByItem, popularity,
  spending, itemStats,
  resolveRange,
};
