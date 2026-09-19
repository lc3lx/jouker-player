const express = require("express");
const authService = require("../services/authService");
const {
  // user
  listCountries,
  listAgents,
  createTicket,
  createVipTicket,
  getMyTickets,
  getTicket,
  getMessages,
  postMessage,
  markRead,
  cancelTicket,
  rateAgent,
  getMyTicketRating,
  listAgentRatings,
  uploadReceiptImage,
  processReceiptImage,
  uploadReceipt,
  uploadChatImage,
  processChatImage,
  postChatImage,
  // agent
  requireDepositAgent,
  getMyAgentProfile,
  getAgentTickets,
  acceptTicket,
  rejectTicket,
  approveDeposit,
  getAgentWalletSummary,
  agentSalesLog,
  agentDirectCredit,
  agentLookupPlayer,
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
  adminDashboardOverview,
  adminDashboardAgents,
  adminDashboardAgentDetail,
  adminDashboardSales,
} = require("../services/agentDepositService");
const {
  createTicketValidator,
  createVipTicketValidator,
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
router.post("/vip-tickets", createVipTicketValidator, createVipTicket);
router.get("/tickets", getMyTickets);
router.get("/tickets/:ticketId", ticketIdValidator, getTicket);
router.get("/tickets/:ticketId/messages", ticketIdValidator, getMessages);
router.post("/tickets/:ticketId/messages", ticketIdValidator, postMessage);
// A picture in the chat, from either side — the ticket's own access rules
// decide who may post, so this needs no role gate of its own.
router.post(
  "/tickets/:ticketId/image",
  ticketIdValidator,
  uploadChatImage,
  processChatImage,
  postChatImage
);
router.post("/tickets/:ticketId/read", ticketIdValidator, markRead);
router.post("/tickets/:ticketId/cancel", ticketIdValidator, cancelTicket);
// Rating a deal, not an agent: the ticket is the proof the two of them dealt.
router.post("/tickets/:ticketId/rate", ticketIdValidator, rateAgent);
router.get("/tickets/:ticketId/rating", ticketIdValidator, getMyTicketRating);
router.get("/agents/:agentProfileId/ratings", listAgentRatings);
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
router.get("/agent/sales", requireDepositAgent, agentSalesLog);
// Handing coins straight to a player, by id or email — no ticket conversation
// needed, but still written down as one. See agentDirectCredit.
router.get("/agent/lookup-player", requireDepositAgent, agentLookupPlayer);
router.post("/agent/direct-credit", requireDepositAgent, agentDirectCredit);
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

// Dashboard-ready reporting (no UI yet — owner settlement / sales)
router.get("/admin/dashboard/overview", adminDashboardOverview);
router.get("/admin/dashboard/agents", adminDashboardAgents);
router.get("/admin/dashboard/agents/:agentProfileId", adminDashboardAgentDetail);
router.get("/admin/dashboard/sales", adminDashboardSales);

module.exports = router;
