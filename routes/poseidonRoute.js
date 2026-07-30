const express = require("express");
const {
  spin,
  buyBonus,
  session,
  jackpotSettle,
  jackpotRecover,
  jackpotReveal,
  requireUserId,
} = require("../controllers/poseidonController");

const router = express.Router();

router.get("/session",            requireUserId, session);
router.post("/spin",              requireUserId, spin);
router.post("/buy-bonus",         requireUserId, buyBonus);

// Jackpot round endpoints
router.get("/jackpot",            requireUserId, jackpotRecover);   // ?roundId=...
router.post("/jackpot/reveal",    requireUserId, jackpotReveal);    // { roundId, cardIndex }
router.post("/jackpot/settle",    requireUserId, jackpotSettle);    // { roundId }

module.exports = router;
