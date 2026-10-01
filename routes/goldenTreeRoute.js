const express = require("express");
const authService = require("../services/authService");
const {
  spin,
  gamble,
  buyBonus,
  winRules,
  requireUserId,
  session,
} = require("../controllers/goldenTreeController");
const {
  jackpotRecover,
  jackpotReveal,
  jackpotSettle,
} = require("../controllers/goldenTreeJackpotController");

const router = express.Router();

// Public: deployed win-rules metadata only
router.get("/win-rules", winRules);

router.use(authService.protect);

router.post("/spin", requireUserId, spin);
router.post("/gamble", requireUserId, gamble);
router.post("/buy-bonus", requireUserId, buyBonus);
router.get("/session", requireUserId, session);

// Match-3 jackpot (same flow as Zeus / Atlantis)
router.get("/jackpot", jackpotRecover);
router.post("/jackpot/reveal", jackpotReveal);
router.post("/jackpot/revealed", jackpotReveal);
router.post("/jackpot/settle", jackpotSettle);

router.get("/economy", authService.protect, require("../controllers/slotEconomyController").forGame("golden-tree"));

module.exports = router;
