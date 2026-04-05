const asyncHandler = require("express-async-handler");
const Table = require("../models/tableModel");
const WalletTransaction = require("../models/walletTransactionModel");
const {
  getTableGameDebugSnapshot,
  buildAdminRealtimeTablePayload,
  getLiveTableGameForAdmin,
  adminForceEndHandTable,
} = require("../sockets/tableGame");

exports.adminListTables = asyncHandler(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit || 50));
  const tables = await Table.find({}, {
    _id: 1,
    gameType: 1,
    tier: 1,
    tableNumber: 1,
    status: 1,
    seats: 1,
    updatedAt: 1,
  }).limit(limit);

  const enriched = tables.map((t) => {
    const live = getTableGameDebugSnapshot(String(t._id));
    return {
      tableId: t._id,
      gameType: t.gameType,
      tier: t.tier,
      tableNumber: t.tableNumber,
      status: t.status,
      seated: t.seats.length,
      live,
    };
  });

  res.status(200).json({ status: "success", results: enriched.length, data: enriched });
});

exports.adminListPlayers = asyncHandler(async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit || 100));
  const tables = await Table.find({}, { _id: 1, tableNumber: 1, seats: 1 }).limit(200);
  const players = [];
  for (const t of tables) {
    for (const s of t.seats || []) {
      players.push({
        userId: s.user,
        tableId: t._id,
        tableNumber: t.tableNumber,
        chips: s.chips,
        joinedAt: s.joinedAt,
      });
      if (players.length >= limit) break;
    }
    if (players.length >= limit) break;
  }
  res.status(200).json({ status: "success", results: players.length, data: players });
});

exports.adminListTransactions = asyncHandler(async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit || 100));
  const q = {};
  if (req.query.userId) q.userId = req.query.userId;
  if (req.query.tableId) q.tableId = req.query.tableId;
  if (req.query.handId) q.handId = req.query.handId;
  const rows = await WalletTransaction.find(q).sort({ createdAt: -1 }).limit(limit);
  res.status(200).json({ status: "success", results: rows.length, data: rows });
});

exports.adminRealtimeTables = asyncHandler(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit || 50));
  const tables = await Table.find(
    {},
    {
      _id: 1,
      gameType: 1,
      tier: 1,
      tableNumber: 1,
      status: 1,
      seats: 1,
      smallBlind: 1,
      bigBlind: 1,
      minBuyIn: 1,
      maxBuyIn: 1,
      updatedAt: 1,
    }
  ).limit(limit);

  const rows = await Promise.all(
    tables.map(async (t) => {
      const game = await getLiveTableGameForAdmin(String(t._id));
      const realtime = buildAdminRealtimeTablePayload(game);
      return {
        tableId: t._id,
        gameType: t.gameType,
        tier: t.tier,
        tableNumber: t.tableNumber,
        status: t.status,
        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,
        minBuyIn: t.minBuyIn,
        maxBuyIn: t.maxBuyIn,
        mongoSeated: (t.seats || []).length,
        mongoPlayers: (t.seats || []).map((s) => ({
          userId: s.user,
          chips: s.chips,
        })),
        realtime,
        liveSummary: getTableGameDebugSnapshot(String(t._id)),
      };
    })
  );

  res.status(200).json({ status: "success", results: rows.length, data: rows });
});

exports.adminForceEndHand = asyncHandler(async (req, res) => {
  const tableId = req.body?.tableId || req.query?.tableId;
  if (!tableId) {
    return res.status(400).json({ status: "error", message: "tableId is required" });
  }
  const result = await adminForceEndHandTable(String(tableId));
  res.status(200).json({ status: "success", data: result });
});

