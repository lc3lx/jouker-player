const express = require("express");
const authService = require("../services/authService");
const {
  getMyTicket,
  createTicket,
  getMessages,
  postMessage,
  markRead,
  adminListTickets,
  adminCloseTicket,
  adminAssignTicket,
  adminOpenCounts,
} = require("../services/supportService");

const router = express.Router();

router.use(authService.protect);

const playerOrStaff = authService.allowedTo(
  "user",
  "support",
  "manager",
  "admin",
  "superadmin"
);
const staffOnly = authService.allowedTo(
  "support",
  "manager",
  "admin",
  "superadmin"
);

router.get("/ticket", playerOrStaff, getMyTicket);
router.post("/ticket", playerOrStaff, createTicket);
router.get("/tickets/:ticketId/messages", playerOrStaff, getMessages);
router.post("/tickets/:ticketId/messages", playerOrStaff, postMessage);
router.post("/tickets/:ticketId/read", playerOrStaff, markRead);

router.get("/admin/tickets", staffOnly, adminListTickets);
router.get("/admin/counts", staffOnly, adminOpenCounts);
router.post("/admin/tickets/:ticketId/close", staffOnly, adminCloseTicket);
router.post("/admin/tickets/:ticketId/assign", staffOnly, adminAssignTicket);

module.exports = router;
