const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const Table = require("../models/tableModel");
const HandHistory = require("../models/handHistoryModel");
const { buildHandAuditLog } = require("./handHistoryAuditService");

exports.buildHandAuditLog = buildHandAuditLog;

exports.authorizeTableAccess = asyncHandler(async (req, res, next) => {
  const tableId = req.params.id;
  const table = await Table.findById(tableId).select("seats");
  if (!table) return next(new ApiError("Table not found", 404));

  // Admins bypass
  if (req.user && Array.isArray(req.user.roles) && (req.user.roles.includes("admin") || req.user.roles.includes("manager"))) {
    return next();
  }

  // Must be seated at table
  const ok = table.seats.some((s) => String(s.user) === String(req.user._id));
  if (!ok) return next(new ApiError("Not authorized to view this table history", 403));
  next();
});

exports.getTableHistory = asyncHandler(async (req, res) => {
  const tableId = req.params.id;
  const page = parseInt(req.query.page || "1", 10);
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const skip = (page - 1) * limit;

  const filter = { table: tableId };
  const total = await HandHistory.countDocuments(filter);
  const items = await HandHistory.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .select("-provablyFair.serverSeed");

  const data = items.map((doc) => {
    const o = doc.toObject ? doc.toObject() : doc;
    if (!o.auditLog || o.auditLog.length === 0) {
      o.auditLog = buildHandAuditLog(o.actions, o.seats || [], o.community || []);
    }
    return o;
  });

  res.status(200).json({
    results: data.length,
    paginationResult: {
      currentPage: page,
      limit,
      numberOfPages: Math.ceil(total / limit),
      next: page * limit < total ? page + 1 : null,
    },
    data,
  });
});
