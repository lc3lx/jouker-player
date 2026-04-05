const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const ApiError = require("../utils/apiError");
const { trackEventServer } = require("../services/analyticsService");

const router = express.Router();

const CLIENT_EVENTS = new Set([
  "click_deposit",
  "claim_bonus",
  "user_join_table",
]);

router.post(
  "/event",
  authService.protect,
  asyncHandler(async (req, res, next) => {
    const name = String(req.body?.name || "").trim();
    if (!CLIENT_EVENTS.has(name)) {
      return next(new ApiError("Unknown or disallowed event name", 400));
    }
    const props = req.body?.props;
    await trackEventServer(
      name,
      req.user._id,
      props && typeof props === "object" ? props : {},
      "client"
    );
    res.status(204).end();
  })
);

module.exports = router;
