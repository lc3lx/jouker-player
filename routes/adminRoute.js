const express = require("express");
const authService = require("../services/authService");
const {
  adminListTables,
  adminListPlayers,
  adminListTransactions,
  adminRealtimeTables,
  adminForceEndHand,
} = require("../services/adminService");
const {
  uploadCosmeticPreview,
  resizeCosmeticPreview,
  adminListCosmetics,
  adminGetCosmetic,
  adminCreateCosmetic,
  adminUpdateCosmetic,
  adminDeleteCosmetic,
} = require("../services/adminCosmeticsService");
const {
  adminGetCurrencySettings,
  adminUpdateCurrencySettings,
} = require("../services/currencySettingsService");
const { adminListGameSettlements } = require("../services/gameSettlementService");

const router = express.Router();

router.use(authService.protect, authService.allowedTo("admin", "manager"));

router.get("/tables", adminListTables);
router.get("/realtime-tables", adminRealtimeTables);
router.post("/force-end-hand", adminForceEndHand);
router.get("/players", adminListPlayers);
router.get("/transactions", adminListTransactions);

router.get("/cosmetics", adminListCosmetics);
router.get("/cosmetics/:id", adminGetCosmetic);
router.post(
  "/cosmetics",
  uploadCosmeticPreview,
  resizeCosmeticPreview,
  adminCreateCosmetic
);
router.put(
  "/cosmetics/:id",
  uploadCosmeticPreview,
  resizeCosmeticPreview,
  adminUpdateCosmetic
);
router.delete("/cosmetics/:id", adminDeleteCosmetic);

router.get("/currency-settings", adminGetCurrencySettings);
router.put("/currency-settings", adminUpdateCurrencySettings);

router.get("/game-settlements", adminListGameSettlements);

module.exports = router;

