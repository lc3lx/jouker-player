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
const lobbyService = require("../services/lobbyService");
const vipTableService = require("../services/vipTableService");

const router = express.Router();

// ── Lobby routes (before /:id to avoid param conflict) ──────────────────
// GET /tables/lobby?gameType=&tier=&page=&limit=&kind=static|dynamic|vip
router.get("/lobby", lobbyService.getFullLobby);
// GET /tables/lobby/static|dynamic|vip
router.get("/lobby/static", lobbyService.getStaticLobby);
router.get("/lobby/dynamic", lobbyService.getDynamicLobby);
router.get("/lobby/vip", lobbyService.getVipLobby);

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

// ── VIP table routes ─────────────────────────────────────────────────────
// Creation (VIP users only)
router.post("/vip", authService.protect, vipTableService.assertVipUser, vipTableService.createVipHandler);

// Owner controls
router.post("/:id/vip/kick",               authService.protect, vipTableService.kick);
router.post("/:id/vip/lock",               authService.protect, vipTableService.lockTable);
router.post("/:id/vip/unlock",             authService.protect, vipTableService.unlockTable);
router.post("/:id/vip/transfer-ownership", authService.protect, vipTableService.transferOwnership);
router.post("/:id/vip/toggle-spectators",  authService.protect, vipTableService.toggleSpectators);
router.post("/:id/vip/toggle-bots",        authService.protect, vipTableService.toggleBots);
router.post("/:id/vip/start",              authService.protect, vipTableService.start);
// Table destruction (VIP owner destroys their table)
router.delete("/:id", authService.protect, vipTableService.destroy);

module.exports = router;
