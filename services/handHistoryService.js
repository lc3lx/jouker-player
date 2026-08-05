const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const Table = require("../models/tableModel");
const HandHistory = require("../models/handHistoryModel");
const { buildHandAuditLog } = require("./handHistoryAuditService");

exports.buildHandAuditLog = buildHandAuditLog;

function isStaff(user) {
  const roles = [user?.role, ...(Array.isArray(user?.roles) ? user.roles : [])]
    .filter(Boolean)
    .map((role) => String(role).toLowerCase());
  return roles.includes("admin") || roles.includes("manager");
}

/**
 * A completed hand can contain every player's private hole cards for audit
 * purposes. Never return those cards to another normal player. The caller's
 * own cards are retained so their personal history remains useful.
 */
function redactHistoryForPlayer(doc, userId, { staff = false } = {}) {
  const out = doc?.toObject ? doc.toObject() : { ...doc };
  if (staff || !out) return out;

  if (out.provablyFair && typeof out.provablyFair === "object") {
    delete out.provablyFair.serverSeed;
  }

  if (Array.isArray(out.seats)) {
    out.seats = out.seats.map((seat) => {
      const row = { ...seat };
      const seatUser = row.user?._id || row.user;
      if (String(seatUser || "") !== String(userId || "")) {
        delete row.hole;
      }
      return row;
    });
  }
  return out;
}

function participantFilter(userId) {
  return { "players.user": userId };
}

exports.authorizeTableAccess = asyncHandler(async (req, res, next) => {
  const tableId = req.params.id;
  const table = await Table.findById(tableId).select("seats");
  if (!table) return next(new ApiError("Table not found", 404));

  // Staff can inspect a table for support and dispute resolution.
  if (isStaff(req.user)) {
    return next();
  }

  // A player keeps access to hands they played after cashing out. Merely
  // sitting at a table now must not grant access to another player's past.
  const participated = await HandHistory.exists({
    table: tableId,
    ...participantFilter(req.user._id),
  });
  if (!participated) return next(new ApiError("Not authorized to view this table history", 403));
  next();
});

exports.getTableHistory = asyncHandler(async (req, res) => {
  const tableId = req.params.id;
  const page = parseInt(req.query.page || "1", 10);
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const skip = (page - 1) * limit;

  const staff = isStaff(req.user);
  const filter = {
    table: tableId,
    ...(staff ? {} : participantFilter(req.user._id)),
  };
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
    return redactHistoryForPlayer(o, req.user?._id, { staff });
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

exports.isStaff = isStaff;
exports.participantFilter = participantFilter;
exports.redactHistoryForPlayer = redactHistoryForPlayer;
