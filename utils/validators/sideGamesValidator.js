const { body, query } = require("express-validator");
const validatorMiddleware = require("../../middlewares/validatorMiddleware");

const types = ["golden-eagle-slot", "fruit-slot", "thunder-king", "lucky-dice"];

exports.listValidator = [
  query("limit").optional().isInt({ min: 1, max: 100 }),
  validatorMiddleware,
];

exports.playValidator = [
  body("type").notEmpty().isIn(types).withMessage("invalid type"),
  body("bet").notEmpty().isFloat({ min: 0.01 }).withMessage("bet must be > 0"),
  validatorMiddleware,
];
