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

router.get("/session", requireUserId, session);
router.post("/spin", requireUserId, spin);
router.post("/buy-bonus", requireUserId, buyBonus);

// Jackpot — match-3: POST body { roundId, cardIndex } → one card face
router.get("/jackpot", requireUserId, jackpotRecover);
router.post("/jackpot/revealed", requireUserId, jackpotReveal);
router.post("/jackpot/reveal", requireUserId, jackpotReveal);
router.post("/jackpot/settle", requireUserId, jackpotSettle);

module.exports = router;
