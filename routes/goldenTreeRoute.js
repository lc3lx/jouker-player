const express = require("express");
const {
  spin,
  gamble,
  buyBonus,
  requireUserId,
} = require("../controllers/goldenTreeController");

const router = express.Router();

router.post("/spin", requireUserId, spin);
router.post("/gamble", requireUserId, gamble);
router.post("/buy-bonus", requireUserId, buyBonus);

module.exports = router;
