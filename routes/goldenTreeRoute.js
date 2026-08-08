const express = require("express");
const {
  spin,
  gamble,
  buyBonus,
  requireUserId,
} = require("../controllers/goldenTreeController");
const {
  jackpotRecover,
  jackpotReveal,
  jackpotSettle,
} = require("../controllers/goldenTreeJackpotController");

const router = express.Router();

router.post("/spin", requireUserId, spin);
router.post("/gamble", requireUserId, gamble);
router.post("/buy-bonus", requireUserId, buyBonus);

// Match-3 jackpot (same flow as Zeus / Atlantis)
router.get("/jackpot", jackpotRecover);
router.post("/jackpot/reveal", jackpotReveal);
router.post("/jackpot/revealed", jackpotReveal);
router.post("/jackpot/settle", jackpotSettle);

module.exports = router;
