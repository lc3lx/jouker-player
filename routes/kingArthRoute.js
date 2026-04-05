const express = require("express");
const authService = require("../services/authService");
const {
  verifySpin,
  listRevealedSeeds,
  getSessionAnalytics,
} = require("../services/kingArthFairnessService");

const router = express.Router();

/** Provable fairness: verify any round with disclosed serverSeed (no auth). */
router.post("/verify-spin", verifySpin);

router.get(
  "/fairness/revealed-seeds",
  authService.protect,
  listRevealedSeeds
);

router.get(
  "/analytics/session",
  authService.protect,
  getSessionAnalytics
);

module.exports = router;
