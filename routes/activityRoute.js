const express = require("express");
const authService = require("../services/authService");
const {
  getActivitiesFeed,
  getActivitiesSummary,
} = require("../services/activityService");

const router = express.Router();

router.use(authService.protect, authService.allowedTo("user"));

router.get("/feed", getActivitiesFeed);
router.get("/summary", getActivitiesSummary);

module.exports = router;
