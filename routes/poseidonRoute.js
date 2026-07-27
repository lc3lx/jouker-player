const express = require("express");
const {
  spin,
  buyBonus,
  session,
  requireUserId,
} = require("../controllers/poseidonController");

const router = express.Router();

router.get("/session", requireUserId, session);
router.post("/spin", requireUserId, spin);
router.post("/buy-bonus", requireUserId, buyBonus);

module.exports = router;
