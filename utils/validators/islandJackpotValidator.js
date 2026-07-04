const { body } = require("express-validator");
const validatorMiddleware = require("../../middlewares/validatorMiddleware");

exports.adminUpdateConfigValidator = [
  body("enabled").optional().isBoolean(),
  body("minTriggerAmount").optional().isInt({ min: 0 }),
  body("entryFee").optional().isInt({ min: 0 }),
  body("payoutPercentages.royalFlush").optional().isFloat({ min: 0, max: 1 }),
  body("payoutPercentages.straightFlush").optional().isFloat({ min: 0, max: 1 }),
  body("payoutPercentages.fourOfAKind").optional().isFloat({ min: 0, max: 1 }),
  body("payoutPolicy.maxWinnersPerEvent").optional().isInt({ min: 1, max: 2 }),
  body("settings.effectsEnabled").optional().isBoolean(),
  body("settings.announcementsEnabled").optional().isBoolean(),
  body("settings.hotJackpotThreshold").optional().isInt({ min: 0 }),
  validatorMiddleware,
];
