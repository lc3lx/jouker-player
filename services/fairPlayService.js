const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const HandHistory = require("../models/handHistoryModel");
const Table = require("../models/tableModel");

/**
 * Last completed hand on this table for fair-play display (user must have a seat in DB or history).
 */
exports.getFairPlayLastHand = asyncHandler(async (req, res, next) => {
  const tableId = req.params.id;
  const table = await Table.findById(tableId).select("seats");
  if (!table) return next(new ApiError("Table not found", 404));

  const uid = String(req.user._id);
  const seated = (table.seats || []).some((s) => String(s.user) === uid);
  if (!seated) {
    return next(new ApiError("Join the table to view fair-play data", 403));
  }

  const hand = await HandHistory.findOne({ table: tableId })
    .sort({ endedAt: -1 })
    .select("handId community pot provablyFair endedAt")
    .lean();

  if (!hand) {
    return res.status(200).json({
      status: "success",
      data: { hand: null, message: "No completed hands yet on this table." },
    });
  }

  res.status(200).json({
    status: "success",
    data: {
      handId: hand.handId,
      community: hand.community || [],
      pot: hand.pot,
      endedAt: hand.endedAt,
      provablyFair: hand.provablyFair || null,
    },
  });
});
