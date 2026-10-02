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

router.get("/economy", authService.optionalProtect, require("../controllers/slotEconomyController").forGame("zeus"));
router.get("/session", authService.optionalProtect, require("express-async-handler")(async (req, res) => {
  const userId = req.user?._id || req.user?.id || req.query.userId;
  if (!userId) {
    return res.json({ status: "success", data: { active: false } });
  }
  const session = await require("../games/dice/kingArthRoundState").getFreeSpinSession(String(userId), "king-arth");
  res.json({ status: "success", data: session ? {
    active: true, betAmount: session.lockedBaseBet, doubleChance: !!session.lockedDoubleChance,
    freeSpinsRemaining: session.remaining, bonusMultiplier: session.totalMultiplier || 0,
    totalWon: session.roundWon || 0, superBonus: !!session.superBonus,
    economyVersion: session.economyVersion || 1,
  } : { active: false } });
}));

module.exports = router;
