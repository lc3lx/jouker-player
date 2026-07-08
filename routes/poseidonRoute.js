const express = require("express");
const {
  spin,
  buyBonus,
  requireUserId,
} = require("../controllers/poseidonController");

const router = express.Router();

router.post("/spin", requireUserId, spin);
router.post("/buy-bonus", requireUserId, buyBonus);

module.exports = router;
