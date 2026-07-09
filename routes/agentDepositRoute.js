const express = require("express");
const authService = require("../services/authService");
const {
  // user
  listCountries,
  listAgents,
  createTicket,
  getMyTickets,
  getTicket,
  getMessages,
  postMessage,
  markRead,
  cancelTicket,
  uploadReceiptImage,
  processReceiptImage,
  uploadReceipt,
  // agent
  requireDepositAgent,
  getMyAgentProfile,
  getAgentTickets,
  acceptTicket,
  rejectTicket,
  approveDeposit,
  getAgentWalletSummary,
  // admin
  adminListAgents,
  adminCreateAgent,
  adminSetAgentStatus,
  adminAssignCountries,
  adminRechargeAgentWallet,
  adminWithdrawAgentBalance,
  adminGetAgentWallet,
  adminListTickets,
  adminForceCloseTicket,
  adminTransferTicket,
  adminStatistics,
} = require("../services/agentDepositService");
const {
  createTicketValidator,
  ticketIdValidator,
  approveDepositValidator,
  adminCreateAgentValidator,
  adminWalletAdjustValidator,
} = require("../utils/validators/agentDepositValidator");

const router = express.Router();

router.use(authService.protect);

// --- user ---
router.get("/countries", listCountries);
router.get("/countries/:country/agents", listAgents);
router.post("/tickets", createTicketValidator, createTicket);
router.get("/tickets", getMyTickets);
router.get("/tickets/:ticketId", ticketIdValidator, getTicket);
router.get("/tickets/:ticketId/messages", ticketIdValidator, getMessages);
router.post("/tickets/:ticketId/messages", ticketIdValidator, postMessage);
router.post("/tickets/:ticketId/read", ticketIdValidator, markRead);
router.post("/tickets/:ticketId/cancel", ticketIdValidator, cancelTicket);
router.post(
  "/tickets/:ticketId/receipt",
  ticketIdValidator,
  uploadReceiptImage,
  processReceiptImage,
  uploadReceipt
);

// --- agent ---
router.get("/agent/me", getMyAgentProfile);
router.get("/agent/tickets", requireDepositAgent, getAgentTickets);
router.get("/agent/wallet", requireDepositAgent, getAgentWalletSummary);
router.post(
  "/agent/tickets/:ticketId/accept",
  requireDepositAgent,
  ticketIdValidator,
  acceptTicket
);
router.post(
  "/agent/tickets/:ticketId/reject",
  requireDepositAgent,
  ticketIdValidator,
  rejectTicket
);
router.post(
  "/agent/tickets/:ticketId/approve",
  requireDepositAgent,
  approveDepositValidator,
  approveDeposit
);

// --- admin ---
router.use("/admin", authService.allowedTo("admin", "manager"));
router.get("/admin/agents", adminListAgents);
router.post("/admin/agents", adminCreateAgentValidator, adminCreateAgent);
router.put("/admin/agents/:agentProfileId/status", adminSetAgentStatus);
router.put("/admin/agents/:agentProfileId/countries", adminAssignCountries);
router.post(
  "/admin/agents/:agentProfileId/wallet/recharge",
  adminWalletAdjustValidator,
  adminRechargeAgentWallet
);
router.post(
  "/admin/agents/:agentProfileId/wallet/withdraw",
  adminWalletAdjustValidator,
  adminWithdrawAgentBalance
);
router.get("/admin/agents/:agentProfileId/wallet", adminGetAgentWallet);
router.get("/admin/tickets", adminListTickets);
router.get("/admin/tickets/:ticketId/messages", ticketIdValidator, getMessages);
router.post("/admin/tickets/:ticketId/close", ticketIdValidator, adminForceCloseTicket);
router.post("/admin/tickets/:ticketId/transfer", ticketIdValidator, adminTransferTicket);
router.get("/admin/statistics", adminStatistics);

module.exports = router;
