const express = require("express");
const authService = require("../services/authService");
const {
  getProfile,
  updateProfile,
  getLeaderboard,
  startSession,
  finishSession,
  listMySessions,
  getGameItems,
  getGameItem,
  createGameItem,
  updateGameItem,
  deleteGameItem,
  uploadGameItemImage,
  resizeGameItemImage,
  buyItem,
  listInventory,
  useItem,
  getAchievements,
  getAchievement,
  createAchievement,
  updateAchievement,
  deleteAchievement,
  unlockAchievement,
  getMyAchievements,
} = require("../services/gameService");

const {
  updatePlayerProfileValidator,
  startSessionValidator,
  finishSessionValidator,
  createGameItemValidator,
  updateGameItemValidator,
  deleteGameItemValidator,
  getGameItemValidator,
  buyItemValidator,
  useItemValidator,
  createAchievementValidator,
  updateAchievementValidator,
  deleteAchievementValidator,
  getAchievementValidator,
  unlockAchievementValidator,
} = require("../utils/validators/gameValidator");

const router = express.Router();

// Profile
router
  .route("/profile")
  .get(authService.protect, getProfile)
  .put(authService.protect, updatePlayerProfileValidator, updateProfile);

// Leaderboard (public)
router.get("/leaderboard", getLeaderboard);

// Sessions (protected)
router
  .route("/sessions")
  .post(authService.protect, startSessionValidator, startSession)
  .get(authService.protect, listMySessions);

router.put(
  "/sessions/:id/finish",
  authService.protect,
  finishSessionValidator,
  finishSession
);

// Inventory (protected)
router.get("/inventory", authService.protect, listInventory);
router.post("/items/:id/use", authService.protect, useItemValidator, useItem);
router.get("/profile/achievements", authService.protect, getMyAchievements);

// Items
router
  .route("/items")
  .get(getGameItems)
  .post(
    authService.protect,
    authService.allowedTo("admin", "manager"),
    uploadGameItemImage,
    resizeGameItemImage,
    createGameItemValidator,
    createGameItem
  );

router
  .route("/items/:id")
  .get(getGameItemValidator, getGameItem)
  .put(
    authService.protect,
    authService.allowedTo("admin", "manager"),
    uploadGameItemImage,
    resizeGameItemImage,
    updateGameItemValidator,
    updateGameItem
  )
  .delete(
    authService.protect,
    authService.allowedTo("admin"),
    deleteGameItemValidator,
    deleteGameItem
  );

router.post(
  "/items/:id/buy",
  authService.protect,
  buyItemValidator,
  buyItem
);

// Achievements
router
  .route("/achievements")
  .get(getAchievements)
  .post(
    authService.protect,
    authService.allowedTo("admin", "manager"),
    createAchievementValidator,
    createAchievement
  );

router
  .route("/achievements/:id")
  .get(getAchievementValidator, getAchievement)
  .put(
    authService.protect,
    authService.allowedTo("admin", "manager"),
    updateAchievementValidator,
    updateAchievement
  )
  .delete(
    authService.protect,
    authService.allowedTo("admin"),
    deleteAchievementValidator,
    deleteAchievement
  );

router.post(
  "/achievements/unlock/:code",
  authService.protect,
  unlockAchievementValidator,
  unlockAchievement
);

module.exports = router;
