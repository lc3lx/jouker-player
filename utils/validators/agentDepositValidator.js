const { check } = require("express-validator");
const validatorMiddleware = require("../../middlewares/validatorMiddleware");

exports.createTicketValidator = [
  check("agentProfileId").isMongoId().withMessage("agentProfileId غير صالح"),
  check("amount")
    .isFloat({ min: 1 })
    .withMessage("المبلغ المطلوب غير صالح"),
  check("paymentMethod").optional().isString().isLength({ max: 60 }),
  check("currency").optional().isString().isLength({ max: 12 }),
  check("country").optional().isString().isLength({ min: 2, max: 2 }),
  validatorMiddleware,
];

exports.ticketIdValidator = [
  check("ticketId").isMongoId().withMessage("ticketId غير صالح"),
  validatorMiddleware,
];

exports.approveDepositValidator = [
  check("ticketId").isMongoId().withMessage("ticketId غير صالح"),
  check("amount").optional().isFloat({ min: 1 }).withMessage("المبلغ غير صالح"),
  validatorMiddleware,
];

exports.adminCreateAgentValidator = [
  check("userId").optional().isMongoId(),
  check("email").optional().isEmail(),
  check("countries").isArray({ min: 1 }).withMessage("حدد دولة واحدة على الأقل"),
  check("displayName").optional().isString().isLength({ max: 80 }),
  check("paymentMethods").optional().isArray(),
  check("workingHours").optional().isString().isLength({ max: 120 }),
  validatorMiddleware,
];

exports.adminWalletAdjustValidator = [
  check("agentProfileId").isMongoId().withMessage("agentProfileId غير صالح"),
  check("amount").isFloat({ min: 1 }).withMessage("المبلغ غير صالح"),
  validatorMiddleware,
];
