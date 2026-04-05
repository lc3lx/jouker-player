const { check, body, param } = require("express-validator");
const validatorMiddleware = require("../../middlewares/validatorMiddleware");

const rarityEnum = ["common", "rare", "epic", "legendary"];

exports.getByIdValidator = [
  param("id").isMongoId().withMessage("Invalid id format"),
  validatorMiddleware,
];

exports.updatePlayerProfileValidator = [
  body("displayName").optional().isString().isLength({ min: 1, max: 64 }),
  body("avatar").optional().isString(),
  validatorMiddleware,
];

// Sessions
exports.startSessionValidator = [
  body("metadata").optional().isObject().withMessage("metadata must be an object"),
  validatorMiddleware,
];
exports.finishSessionValidator = [
  param("id").isMongoId().withMessage("Invalid session id format"),
  body("score").notEmpty().withMessage("score required").isNumeric().withMessage("score must be numeric"),
  body("durationSec").notEmpty().withMessage("durationSec required").isNumeric().withMessage("durationSec must be numeric"),
  body("won").optional().isBoolean().withMessage("won must be boolean"),
  body("tournament").optional().isMongoId().withMessage("tournament must be a MongoId"),
  validatorMiddleware,
];

// Items
exports.createGameItemValidator = [
  body("name").notEmpty().withMessage("name required").isLength({ min: 2, max: 64 }),
  body("price").notEmpty().withMessage("price required").isFloat({ min: 0 }),
  body("rarity").optional().isIn(rarityEnum).withMessage("invalid rarity"),
  body("stock").optional().isInt({ min: 0 }).withMessage("invalid stock"),
  validatorMiddleware,
];

exports.updateGameItemValidator = [
  param("id").isMongoId().withMessage("Invalid item id format"),
  body("name").optional().isLength({ min: 2, max: 64 }),
  body("price").optional().isFloat({ min: 0 }),
  body("rarity").optional().isIn(rarityEnum),
  body("stock").optional().isInt({ min: 0 }),
  validatorMiddleware,
];

exports.deleteGameItemValidator = [
  param("id").isMongoId().withMessage("Invalid item id format"),
  validatorMiddleware,
];

exports.getGameItemValidator = [
  param("id").isMongoId().withMessage("Invalid item id format"),
  validatorMiddleware,
];

exports.buyItemValidator = [
  param("id").isMongoId().withMessage("Invalid item id format"),
  body("quantity").optional().isInt({ min: 1 }).withMessage("quantity must be >= 1"),
  validatorMiddleware,
];

exports.useItemValidator = [
  param("id").isMongoId().withMessage("Invalid item id format"),
  validatorMiddleware,
];

// Achievements
exports.createAchievementValidator = [
  body("code").notEmpty().withMessage("code required").isLength({ min: 2, max: 64 }),
  body("title").notEmpty().withMessage("title required"),
  body("points").optional().isInt({ min: 0 }),
  validatorMiddleware,
];

exports.updateAchievementValidator = [
  param("id").isMongoId().withMessage("Invalid achievement id format"),
  body("code").optional().isLength({ min: 2, max: 64 }),
  body("title").optional().isString(),
  body("points").optional().isInt({ min: 0 }),
  validatorMiddleware,
];

exports.deleteAchievementValidator = [
  param("id").isMongoId().withMessage("Invalid achievement id format"),
  validatorMiddleware,
];

exports.getAchievementValidator = [
  param("id").isMongoId().withMessage("Invalid achievement id format"),
  validatorMiddleware,
];

exports.unlockAchievementValidator = [
  param("code").isString().isLength({ min: 1, max: 64 }),
  validatorMiddleware,
];
