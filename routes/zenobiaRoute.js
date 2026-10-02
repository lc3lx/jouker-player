const express = require("express");
const authService = require("../services/authService");
const {
  spin,
  buyBonus,
  session,
  requireUserId,
  jackpotRecover,
  jackpotReveal,
  jackpotSettle,
} = require("../controllers/zenobiaController");

const router = express.Router();

// Public paytable / rules — optional auth to attach user's active bonus state if logged in
router.get("/economy", authService.optionalProtect, require("../controllers/slotEconomyController").forGame("zenobia"));

router.use(authService.protect);

router.get("/session", requireUserId, session);
router.post("/spin", requireUserId, spin);
router.post("/buy-bonus", requireUserId, buyBonus);
router.get("/jackpot", requireUserId, jackpotRecover);
router.post("/jackpot/reveal", requireUserId, jackpotReveal);
router.post("/jackpot/revealed", requireUserId, jackpotReveal);
router.post("/jackpot/settle", requireUserId, jackpotSettle);

module.exports = router;
