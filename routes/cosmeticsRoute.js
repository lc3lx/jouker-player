const express = require("express");
const authService = require("../services/authService");
const cosmeticsController = require("../controllers/cosmeticsController");

const router = express.Router();

router.use(authService.protect);

router.get("/catalog", authService.allowedTo("user"), cosmeticsController.getCatalog);
router.get("/categories", authService.allowedTo("user"), cosmeticsController.getCategories);
router.get("/featured", authService.allowedTo("user"), cosmeticsController.getFeatured);
router.get("/recommended", authService.allowedTo("user"), cosmeticsController.getRecommended);
router.get("/me", authService.allowedTo("user"), cosmeticsController.getMe);
router.post("/buy", authService.allowedTo("user"), cosmeticsController.postBuy);
router.post("/equip", authService.allowedTo("user"), cosmeticsController.postEquip);

module.exports = router;
