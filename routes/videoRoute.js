const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const ApiError = require("../utils/apiError");
const { createPokerTableVideoToken } = require("../services/tableVideoTokenService");

const router = express.Router();

/**
 * @route   GET /api/v1/video/token?tableId=
 * @access  Private — must be seated at the poker table (Mongo seats)
 */
router.get(
  "/token",
  authService.protect,
  asyncHandler(async (req, res) => {
    const tableId = (req.query.tableId || "").toString().trim();
    if (!tableId) {
      throw new ApiError("tableId is required", 400);
    }

    const displayName = (req.user && req.user.name) || "";

    const data = await createPokerTableVideoToken({
      userId: req.user._id,
      tableId,
      displayName,
    });

    res.status(200).json({ data });
  })
);

module.exports = router;
