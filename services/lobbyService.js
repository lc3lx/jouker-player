/**
 * LobbyService — read-only table query layer for Phase 2 lobby sections.
 * Separates lobby read concerns from tableService.js lifecycle operations.
 * All functions are Express asyncHandler middleware.
 */
const asyncHandler = require("express-async-handler");
const Table = require("../models/tableModel");
const { LOBBY_EXCLUDED_STATUSES } = require("./tableLifecycleService");
const { getWaitingQueueSize } = require("./pokerWaitingQueueService");
const spectatorService = require("./spectatorService");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Fields included in every lobby row. */
const LOBBY_SELECT =
  "gameType tier tableKind tableNumber displayName owner settings " +
  "smallBlind bigBlind minBuyIn maxBuyIn capacity seats status waitingQueue";

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page || "1", 10));
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit || String(DEFAULT_LIMIT), 10)));
  return { page, limit, skip: (page - 1) * limit };
}

function buildBaseFilter(query, kind) {
  const filter = {
    tableKind: kind,
    status: { $nin: LOBBY_EXCLUDED_STATUSES },
  };
  if (query.gameType) filter.gameType = query.gameType;
  if (query.tier) filter.tier = query.tier;
  return filter;
}

async function enrichRow(t) {
  const o = t.toObject ? t.toObject() : t;
  const tid = String(t._id);
  const qSize =
    o.gameType === "poker"
      ? await getWaitingQueueSize(tid)
      : Array.isArray(o.waitingQueue)
      ? o.waitingQueue.length
      : 0;
  return {
    ...o,
    waitingQueueSize: qSize,
    spectatorCount: spectatorService.getCount(tid),
    seatedCount: Array.isArray(o.seats) ? o.seats.length : 0,
  };
}

async function querySection(filter, { page, limit, skip }) {
  const total = await Table.countDocuments(filter);
  const rows = await Table.find(filter)
    .sort({ tableNumber: 1 })
    .skip(skip)
    .limit(limit)
    .select(LOBBY_SELECT);
  const data = await Promise.all(rows.map(enrichRow));
  return {
    results: rows.length,
    total,
    page,
    pages: Math.ceil(total / limit),
    data,
  };
}

// ─── Route handlers ───────────────────────────────────────────────────────

/**
 * GET /tables/lobby/static
 * Static tables (permanent, per game/tier).
 */
exports.getStaticLobby = asyncHandler(async (req, res) => {
  const pagination = parsePagination(req.query);
  const filter = buildBaseFilter(req.query, "static");
  res.status(200).json(await querySection(filter, pagination));
});

/**
 * GET /tables/lobby/dynamic
 * Dynamic (auto-scaled) tables.
 */
exports.getDynamicLobby = asyncHandler(async (req, res) => {
  const pagination = parsePagination(req.query);
  const filter = buildBaseFilter(req.query, "dynamic");
  res.status(200).json(await querySection(filter, pagination));
});

/**
 * GET /tables/lobby/vip
 * Public VIP tables (not locked, not private-only).
 */
exports.getVipLobby = asyncHandler(async (req, res) => {
  const pagination = parsePagination(req.query);
  const filter = {
    tableKind: "vip",
    isPrivate: false,
    "settings.isLocked": false,
    status: { $nin: LOBBY_EXCLUDED_STATUSES },
  };
  if (req.query.gameType) filter.gameType = req.query.gameType;
  if (req.query.tier) filter.tier = req.query.tier;
  res.status(200).json(await querySection(filter, pagination));
});

/**
 * GET /tables/lobby  — full lobby: static → dynamic → VIP sections.
 * Optional: ?kind=static|dynamic|vip to filter to one section.
 */
exports.getFullLobby = asyncHandler(async (req, res) => {
  const kind = req.query.kind;
  if (kind === "static") return exports.getStaticLobby(req, res);
  if (kind === "dynamic") return exports.getDynamicLobby(req, res);
  if (kind === "vip") return exports.getVipLobby(req, res);

  const pagination = parsePagination(req.query);
  const gameType = req.query.gameType;
  const tier = req.query.tier;

  const makeFilter = (k, extra = {}) => {
    const f = { tableKind: k, status: { $nin: LOBBY_EXCLUDED_STATUSES }, ...extra };
    if (gameType) f.gameType = gameType;
    if (tier) f.tier = tier;
    return f;
  };

  const [staticRows, dynamicRows, vipRows] = await Promise.all([
    Table.find(makeFilter("static")).sort({ tableNumber: 1 }).select(LOBBY_SELECT),
    Table.find(makeFilter("dynamic")).sort({ tableNumber: 1 }).select(LOBBY_SELECT),
    Table.find(makeFilter("vip", { isPrivate: false, "settings.isLocked": false }))
      .sort({ tableNumber: 1 })
      .select(LOBBY_SELECT),
  ]);

  const allRows = [...staticRows, ...dynamicRows, ...vipRows];
  const data = await Promise.all(allRows.map(enrichRow));

  // Apply pagination to the combined result.
  const total = data.length;
  const { page, limit, skip } = pagination;
  const paged = data.slice(skip, skip + limit);

  res.status(200).json({
    results: paged.length,
    total,
    page,
    pages: Math.ceil(total / limit),
    sections: {
      static: staticRows.length,
      dynamic: dynamicRows.length,
      vip: vipRows.length,
    },
    data: paged,
  });
});
