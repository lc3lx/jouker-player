const { body, param } = require("express-validator");
const validatorMiddleware = require("../../middlewares/validatorMiddleware");

const tiers = ["beginner", "intermediate", "beast", "private"];

exports.createTableValidator = [
  body("tier").notEmpty().isIn(tiers).withMessage("invalid tier"),
  body("tableNumber").notEmpty().isInt({ min: 1 }).withMessage("tableNumber required"),
  body("smallBlind").notEmpty().isFloat({ min: 0 }),
  body("bigBlind").notEmpty().isFloat({ min: 0 }),
  body("minBuyIn").notEmpty().isFloat({ min: 0 }),
  body("maxBuyIn").notEmpty().isFloat({ min: 0 }),
  body("capacity").optional().isInt({ min: 2, max: 10 }),
  body("isPrivate").optional().isBoolean(),
  body("password").custom((val, { req }) => {
    if (req.body.isPrivate && (!val || String(val).trim().length === 0)) {
      throw new Error("password required for private tables");
    }
    return true;
  }),
  body("maxBuyIn").custom((val, { req }) => {
    if (val < req.body.minBuyIn) {
      throw new Error("maxBuyIn must be >= minBuyIn");
    }
    return true;
  }),
  validatorMiddleware,
];

exports.getTableValidator = [
  param("id").isMongoId().withMessage("Invalid table id"),
  validatorMiddleware,
];

exports.joinTableValidator = [
  param("id").isMongoId().withMessage("Invalid table id"),
  body("buyIn").notEmpty().isFloat({ min: 0.01 }).withMessage("buyIn must be > 0"),
  body("password").optional().isString(),
  validatorMiddleware,
];

exports.leaveTableValidator = [
  param("id").isMongoId().withMessage("Invalid table id"),
  validatorMiddleware,
];
