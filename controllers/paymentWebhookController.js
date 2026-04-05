const logger = require("../utils/logger");
const { handleStripeWebhookEvent } = require("../services/paymentService");

/**
 * Raw body required — mounted before express.json in server.js.
 */
async function stripePaymentsWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!secret || !key) {
    logger.warn("stripe_webhook_missing_config");
    return res.status(503).json({ status: "error", message: "Webhook not configured" });
  }

  let stripe;
  try {
    stripe = require("stripe")(key);
  } catch (e) {
    logger.error("stripe_module_missing", { reason: e?.message || "unknown" });
    return res.status(503).json({ status: "error", message: "Stripe not available" });
  }

  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    logger.warn("stripe_webhook_signature_invalid", { reason: err?.message || "unknown" });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await handleStripeWebhookEvent(event);
  } catch (e) {
    logger.error("stripe_webhook_handler_failed", { reason: e?.message || "unknown" });
    return res.status(500).json({ status: "error" });
  }

  return res.json({ received: true });
}

module.exports = { stripePaymentsWebhook };
