const express = require("express");
const authService = require("../services/authService");
const {
  getNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} = require("../services/notificationService");

const router = express.Router();

router.use(authService.protect, authService.allowedTo("user"));

router.get("/", getNotifications);
router.get("/unread-count", getUnreadCount);
router.post("/read-all", markAllNotificationsRead);
router.post("/:id/read", markNotificationRead);

module.exports = router;
