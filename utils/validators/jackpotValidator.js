const { body } = require("express-validator");
const validatorMiddleware = require("../../middlewares/validatorMiddleware");

exports.contributeValidator = [
  body("count").optional().isInt({ min: 1 }).withMessage("count must be >= 1"),
  validatorMiddleware,
];

exports.settleValidator = [
  body("userId").notEmpty().isMongoId().withMessage("userId required and must be MongoId"),
  body("handType").notEmpty().isIn(["royalFlush", "straightFlush", "fullHouse"]).withMessage("invalid handType"),
  validatorMiddleware,
];
