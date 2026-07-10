const express = require("express");
const authService = require("../services/authService");
const adminReferralController = require("../controllers/adminReferralController");

const router = express.Router();

router.use(authService.protect, authService.allowedTo("admin", "manager"));

router.get("/analytics", adminReferralController.listAnalytics);
router.get("/analytics/:referrerId", adminReferralController.getReferrerAnalytics);
router.get("/fraud/:userId", adminReferralController.getFraudProfile);
router.get("/rewards", adminReferralController.listRewards);
router.post("/rewards/:id/approve", adminReferralController.approveReward);
router.post("/rewards/:id/reject", adminReferralController.rejectReward);
router.post("/referrers/:id/suspend", adminReferralController.suspendReferrer);
router.post("/referrers/:id/whitelist", adminReferralController.whitelistReferrer);
router.post("/referrers/:id/blacklist", adminReferralController.blacklistReferrer);
router.post("/referrers/:id/recalculate", adminReferralController.recalculate);
router.get("/xp-history", adminReferralController.listXpHistory);
router.get("/qualifications", adminReferralController.listQualifications);
router.get("/export", adminReferralController.exportReport);
router.get("/audit", adminReferralController.listAuditLog);

module.exports = router;
