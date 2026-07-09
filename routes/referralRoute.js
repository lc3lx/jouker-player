const express = require("express");
const authService = require("../services/authService");
const referralController = require("../modules/referral/controllers/referralController");

const router = express.Router();

router.use(authService.protect, authService.allowedTo("user", "admin", "manager"));

router.get("/me", referralController.getMe);
router.get("/resolve/:code", referralController.resolveCode);
router.get("/invitees", referralController.listInvitees);
router.get("/xp-history", referralController.getXpHistory);
router.post("/milestones/:tierId/claim", referralController.claimMilestone);

module.exports = router;
