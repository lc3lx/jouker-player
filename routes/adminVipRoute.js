const express = require("express");
const authService = require("../services/authService");
const vipService = require("../services/vipService");

const router = express.Router();

router.use(authService.protect, authService.allowedTo("admin", "manager"));

router.get("/", vipService.adminOverview);
router.get("/users/:userId", vipService.adminUserVip);
router.post("/give", vipService.adminGiveVip);
router.post("/remove", vipService.adminRemoveVip);
router.post("/update", vipService.adminUpdateVip);
router.get("/purchase-requests", vipService.adminListPurchaseRequests);
router.get("/pricing", vipService.adminGetPricing);
router.put("/pricing", vipService.adminUpdatePricing);
router.get("/questions", vipService.adminListQuestions);
router.post("/questions", vipService.adminAddQuestion);
router.delete("/questions/:id", vipService.adminDeleteQuestion);

module.exports = router;
