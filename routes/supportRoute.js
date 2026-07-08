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

router.get(
  "/ticket",
  authService.allowedTo("user", "admin", "manager"),
  getMyTicket
);
router.post(
  "/ticket",
  authService.allowedTo("user", "admin", "manager"),
  createTicket
);
router.get(
  "/tickets/:ticketId/messages",
  authService.allowedTo("user", "admin", "manager"),
  getMessages
);
router.post(
  "/tickets/:ticketId/messages",
  authService.allowedTo("user", "admin", "manager"),
  postMessage
);
router.post(
  "/tickets/:ticketId/read",
  authService.allowedTo("user", "admin", "manager"),
  markRead
);

router.get(
  "/admin/tickets",
  authService.allowedTo("admin", "manager"),
  adminListTickets
);
router.get(
  "/admin/counts",
  authService.allowedTo("admin", "manager"),
  adminOpenCounts
);
router.post(
  "/admin/tickets/:ticketId/close",
  authService.allowedTo("admin", "manager"),
  adminCloseTicket
);
router.post(
  "/admin/tickets/:ticketId/assign",
  authService.allowedTo("admin", "manager"),
  adminAssignTicket
);

module.exports = router;
