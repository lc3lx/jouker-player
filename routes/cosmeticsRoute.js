const express = require("express");
const authService = require("../services/authService");
const cosmeticsController = require("../controllers/cosmeticsController");

const router = express.Router();

function bind(name, aliases = []) {
  return (req, res, next) => {
    const fn =
      cosmeticsController[name] ||
      aliases.map((a) => cosmeticsController[a]).find((h) => typeof h === "function");
    if (typeof fn !== "function") {
      return res.status(500).json({ status: "error", message: `cosmetics.${name} unavailable` });
    }
    return fn(req, res, next);
  };
}

router.use(authService.protect);

router.get("/catalog", authService.allowedTo("user"), bind("getCatalog"));
router.get("/categories", authService.allowedTo("user"), bind("getCategories"));
router.get("/featured", authService.allowedTo("user"), bind("getFeatured"));
router.get("/recommended", authService.allowedTo("user"), bind("getRecommended"));
router.get("/me", authService.allowedTo("user"), bind("getMe"));
router.post("/buy", authService.allowedTo("user"), bind("postBuy", ["buy"]));
router.post("/equip", authService.allowedTo("user"), bind("postEquip", ["equip"]));
router.post("/unequip", authService.allowedTo("user"), bind("postUnequip", ["unequip"]));

module.exports = router;
