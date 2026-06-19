const express = require("express");
const {
  getUserWallet,
  createUserWallet,
  rechargeWallet,
  getWalletTransactions,
  checkWalletBalance,
  getAllWallets,
  getWalletByUserId,
  adjustWalletBalance,
  simulatedDeposit,
  simulatedWithdraw,
  getWalletSummary,
} = require("../services/walletService");
const { createPaymentIntent, confirmPayment } = require("../services/paymentService");

const authService = require("../services/authService");

const router = express.Router();

// All routes require authentication
router.use(authService.protect);

// User routes
router.route("/").get(authService.allowedTo("user"), getUserWallet);
router.route("/summary").get(authService.allowedTo("user"), getWalletSummary);
router.route("/create").post(authService.allowedTo("user"), createUserWallet);
router.route("/recharge").post(authService.allowedTo("user"), rechargeWallet);
router
  .route("/transactions")
  .get(authService.allowedTo("user"), getWalletTransactions);
router.route("/balance").get(authService.allowedTo("user"), checkWalletBalance);
router.route("/deposit").post(authService.allowedTo("user"), simulatedDeposit);
router.route("/withdraw").post(authService.allowedTo("user"), simulatedWithdraw);
router
  .route("/payments/intent")
  .post(authService.allowedTo("user"), createPaymentIntent);
router
  .route("/payments/confirm")
  .post(authService.allowedTo("user"), confirmPayment);

// Admin routes
router
  .route("/admin/all")
  .get(authService.allowedTo("admin", "manager"), getAllWallets);
router
  .route("/admin/:userId")
  .get(authService.allowedTo("admin", "manager"), getWalletByUserId);
router
  .route("/admin/:userId/adjust")
  .put(authService.allowedTo("admin"), adjustWalletBalance);

module.exports = router;
