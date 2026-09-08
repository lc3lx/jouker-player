const express = require("express");
const authService = require("../services/authService");
const {
  spin,
  buyBonus,
  session,
  requireUserId,
} = require("../controllers/zenobiaController");

const router = express.Router();

router.use(authService.protect);

router.get("/session", requireUserId, session);
router.post("/spin", requireUserId, spin);
router.post("/buy-bonus", requireUserId, buyBonus);

module.exports = router;
