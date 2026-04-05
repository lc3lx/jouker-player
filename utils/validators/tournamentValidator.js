const { body, param, query } = require("express-validator");
const validatorMiddleware = require("../../middlewares/validatorMiddleware");

exports.createTournamentValidator = [
  body("name").notEmpty().isLength({ min: 2, max: 100 }),
  body("prize").notEmpty().isFloat({ min: 0 }),
  body("entryFee").optional().isFloat({ min: 0 }),
  body("durationMinutes").notEmpty().isInt({ min: 1 }),
  body("startAt").notEmpty().isISO8601(),
  validatorMiddleware,
];

exports.getTournamentValidator = [
  param("id").isMongoId().withMessage("Invalid tournament id"),
  validatorMiddleware,
];

exports.registerTournamentValidator = [
  param("id").isMongoId().withMessage("Invalid tournament id"),
  validatorMiddleware,
];

exports.listTournamentsValidator = [
  query("tab").optional().isIn(["ongoing", "registering", "season", "history"]),
  validatorMiddleware,
];
