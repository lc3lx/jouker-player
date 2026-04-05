const express = require("express");
const authService = require("../services/authService");
const {
  getTables,
  getTable,
  createTable,
  joinTable,
  leaveTable,
} = require("../services/tableService");
const { authorizeTableAccess, getTableHistory } = require("../services/handHistoryService");
const {
  createTableValidator,
  getTableValidator,
  joinTableValidator,
  leaveTableValidator,
} = require("../utils/validators/tableValidator");
const { getFairPlayLastHand } = require("../services/fairPlayService");

const router = express.Router();

router.route("/").get(getTables).post(
  authService.protect,
  authService.allowedTo("admin", "manager"),
  createTableValidator,
  createTable
);

router
  .route("/:id")
  .get(getTableValidator, getTable);

router.post(
  "/:id/join",
  authService.protect,
  joinTableValidator,
  joinTable
);

router.post(
  "/:id/leave",
  authService.protect,
  leaveTableValidator,
  leaveTable
);

router.get(
  "/:id/history",
  authService.protect,
  getTableValidator,
  authorizeTableAccess,
  getTableHistory
);

router.get(
  "/:id/fair-play-last-hand",
  authService.protect,
  getTableValidator,
  getFairPlayLastHand
);

module.exports = router;
