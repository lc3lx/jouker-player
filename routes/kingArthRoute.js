const express = require("express");
const authService = require("../services/authService");
const {
  verifySpin,
  listRevealedSeeds,
  getSessionAnalytics,
} = require("../services/kingArthFairnessService");
const {
  jackpotRecover,
  jackpotReveal,
  jackpotSettle,
} = require("../controllers/kingArthJackpotController");

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

// Jackpot match-3 (same flow as Poseidon)
router.get("/jackpot", authService.protect, jackpotRecover);
router.post("/jackpot/reveal", authService.protect, jackpotReveal);
router.post("/jackpot/revealed", authService.protect, jackpotReveal);
router.post("/jackpot/settle", authService.protect, jackpotSettle);

module.exports = router;
