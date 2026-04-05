const express = require("express");
const authService = require("../services/authService");
const {
  adminListTables,
  adminListPlayers,
  adminListTransactions,
  adminRealtimeTables,
  adminForceEndHand,
} = require("../services/adminService");

const router = express.Router();

router.use(authService.protect, authService.allowedTo("admin", "manager"));

router.get("/tables", adminListTables);
router.get("/realtime-tables", adminRealtimeTables);
router.post("/force-end-hand", adminForceEndHand);
router.get("/players", adminListPlayers);
router.get("/transactions", adminListTransactions);

module.exports = router;

