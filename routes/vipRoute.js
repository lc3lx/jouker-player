const express = require("express");
const authService = require("../services/authService");
const vipService = require("../services/vipService");

const router = express.Router();

router.use(authService.protect);

router.get("/status", vipService.getStatus);
router.get("/profile", vipService.getProfile);
router.get("/rewards", vipService.getRewards);
router.post("/claim-daily", vipService.postClaimDaily);
router.post("/claim-cashback", vipService.postClaimCashback);
router.get("/quiz", vipService.getQuiz);
router.post("/quiz", vipService.postQuiz);
router.post("/purchase", vipService.postPurchase);
router.post("/purchase-request", vipService.postPurchaseRequest);
router.get("/purchase-request/mine", vipService.getMyPurchaseRequest);
router.post("/restore", vipService.postRestore);
router.post("/cancel", vipService.postCancel);
router.get("/history", vipService.getHistory);

module.exports = router;
