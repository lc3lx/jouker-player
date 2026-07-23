/**
 * @deprecated Validators for the legacy standalone Tournament REST routes.
 * No longer referenced — routes/tournamentRoute.js was rewritten to a
 * disable gate that doesn't import this file. Replaced by the ClanTournament
 * bracket system. See docs/STANDALONE_TOURNAMENT_DISABLED.md. Kept, not
 * deleted, for a possible future migration.
 */
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
