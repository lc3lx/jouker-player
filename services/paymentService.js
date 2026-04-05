const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const PaymentIntent = require("../models/paymentIntentModel");
const WebhookEvent = require("../models/webhookEventModel");
const {
  withMongoTransaction,
  appendBalancesUnchanged,
  ledgerDeposit,
  ledgerWithdraw,
} = require("./walletLedgerService");
const {
  assertCanDeposit,
  assertCanWithdraw,
  recordDepositCompleted,
  recordWithdrawCompleted,
} = require("./fraudService");
const { trackEventServerFireAndForget } = require("./analyticsService");

function parseAmount(body) {
  const raw = body?.amount;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000_000) return null;
  return n;
}

function newIntentId() {
  return `pi_${crypto.randomBytes(16).toString("hex")}`;
}

function withdrawDelayMs() {
  return Math.max(0, parseInt(process.env.WITHDRAW_DELAY_MS || "2000", 10));
}

function simulatePaymentFailure() {
  return String(process.env.PAYMENT_SIMULATE_FAILURE || "").toLowerCase() === "true";
}

function depositProvider() {
  const p = String(process.env.PAYMENT_DEPOSIT_PROVIDER || "simulated").toLowerCase();
  if (p === "stripe") return "stripe";
  if (p === "crypto_usdt" || p === "crypto") return "crypto_usdt";
  return "simulated";
}

function stripeMinorUnitsForChips(chipAmount) {
  const mult = parseFloat(process.env.STRIPE_MINOR_UNITS_PER_CHIP || "1");
  const n = Math.round(Number(chipAmount) * (Number.isFinite(mult) ? mult : 1));
  return Math.max(1, n);
}

function chipsFromStripeAmount(stripeAmount) {
  const mult = parseFloat(process.env.STRIPE_MINOR_UNITS_PER_CHIP || "1");
  const m = Number.isFinite(mult) && mult !== 0 ? mult : 1;
  return Math.floor(Number(stripeAmount) / m);
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key) return null;
  try {
    return require("stripe")(key);
  } catch (_) {
    return null;
  }
}

/**
 * Apply Stripe webhook: idempotent via WebhookEvent; ledger + intent in one txn.
 */
async function handleStripeWebhookEvent(event) {
  if (!event || !event.id || !event.type) return;

  if (event.type !== "payment_intent.succeeded") {
    return { ignored: true };
  }

  const eventId = String(event.id);
  const dup = await WebhookEvent.findOne({ provider: "stripe", eventId });
  if (dup) {
    return { duplicate: true };
  }

  const pi = event.data.object;
  const providerRef = pi.id;
  const metaIntentId = pi.metadata && pi.metadata.app_intent_id ? String(pi.metadata.app_intent_id) : "";

  let credited = false;
  let replayAckOnly = false;
  let creditUserId;
  let creditIntentId;
  let creditAmount;

  await withMongoTransaction(async (session) => {
    const matchPending = {
      status: "pending",
      flow: "deposit",
      provider: "stripe",
      $or: [{ webhookLockEvent: { $exists: false } }, { webhookLockEvent: eventId }],
    };

    let intent = await PaymentIntent.findOneAndUpdate(
      { providerRef, ...matchPending },
      { $set: { webhookLockEvent: eventId, providerRef } },
      { session, new: true }
    );

    if (!intent && metaIntentId) {
      intent = await PaymentIntent.findOneAndUpdate(
        { intentId: metaIntentId, ...matchPending },
        { $set: { webhookLockEvent: eventId, providerRef } },
        { session, new: true }
      );
    }

    if (!intent) {
      const done = await PaymentIntent.findOne({
        $or: [{ providerRef }, ...(metaIntentId ? [{ intentId: metaIntentId }] : [])],
        status: "completed",
        flow: "deposit",
      }).session(session);
      if (done) {
        replayAckOnly = true;
        return;
      }
      throw new Error("STRIPE_INTENT_NOT_FOUND");
    }

    const expectedStripeAmount = stripeMinorUnitsForChips(intent.amount);
    const received = Number(pi.amount_received || pi.amount || 0);
    if (received !== expectedStripeAmount) {
      throw new Error("STRIPE_AMOUNT_MISMATCH");
    }

    await ledgerDeposit({
      session,
      userId: intent.userId,
      amount: intent.amount,
      meta: { intentId: intent.intentId, source: "stripe_webhook", stripePaymentIntent: providerRef },
      ledgerType: "confirmed_deposit",
    });

    intent.status = "completed";
    intent.completedAt = new Date();
    intent.providerRef = providerRef;
    await intent.save({ session });

    credited = true;
    creditUserId = intent.userId;
    creditIntentId = intent.intentId;
    creditAmount = intent.amount;
  });

  if (credited || replayAckOnly) {
    try {
      await WebhookEvent.create({
        provider: "stripe",
        eventId,
        intentId: metaIntentId || (creditIntentId ? String(creditIntentId) : undefined),
      });
    } catch (e) {
      if (e && e.code === 11000) {
        return { duplicate: true };
      }
      throw e;
    }
  }

  if (credited) {
    await recordDepositCompleted(creditUserId, creditAmount);
    trackEventServerFireAndForget("deposit", creditUserId, {
      intentId: creditIntentId,
      amount: creditAmount,
      provider: "stripe",
    });
  }

  return { ok: true };
}

exports.handleStripeWebhookEvent = handleStripeWebhookEvent;

/**
 * createPaymentIntent(amount, userId) — pending ledger row; balance changes only on confirm / webhook.
 */
exports.createPaymentIntent = asyncHandler(async (req, res, next) => {
  const amount = parseAmount(req.body);
  if (amount == null) return next(new ApiError("Invalid amount", 400));

  const flow = String(req.body?.flow || "deposit").toLowerCase();
  if (!["deposit", "withdraw"].includes(flow)) {
    return next(new ApiError("flow must be deposit or withdraw", 400));
  }

  const userId = req.user._id;
  const intentId = newIntentId();
  const delayMs = flow === "withdraw" ? withdrawDelayMs() : 0;
  const processAfter = delayMs > 0 ? new Date(Date.now() + delayMs) : null;

  let provider = "simulated";
  if (flow === "deposit") {
    const dp = depositProvider();
    if (dp === "stripe") provider = "stripe";
    else if (dp === "crypto_usdt") provider = "crypto_usdt";
    else provider = "simulated";
  }

  try {
    if (flow === "deposit") await assertCanDeposit(userId, amount);
    if (flow === "withdraw") await assertCanWithdraw(userId, amount);
  } catch (e) {
    if (e.message === "TRUST_RESTRICTED") {
      return next(new ApiError("Account restricted — contact support", 403));
    }
    if (e.message === "DEPOSIT_DAILY_LIMIT") {
      return next(new ApiError("Daily deposit limit reached", 400));
    }
    if (e.message === "WITHDRAW_DAILY_LIMIT") {
      return next(new ApiError("Daily withdraw limit reached", 400));
    }
    throw e;
  }

  const stripe = provider === "stripe" ? getStripe() : null;
  if (flow === "deposit" && provider === "stripe" && !stripe) {
    return next(new ApiError("Stripe is not configured", 503));
  }

  try {
    await withMongoTransaction(async (session) => {
      if (flow === "deposit") {
        await appendBalancesUnchanged({
          session,
          userId,
          type: "pending_deposit",
          amount,
          meta: { intentId, provider },
        });
      } else {
        const Wallet = require("../models/walletModel");
        let wq = Wallet.findOne({ user: userId });
        if (session) wq = wq.session(session);
        const w = await wq;
        const bal = Math.floor(Number(w?.balance || 0));
        if (!w || bal < amount) {
          throw new Error("INSUFFICIENT_BALANCE");
        }
        await appendBalancesUnchanged({
          session,
          userId,
          type: "pending_withdraw",
          amount,
          meta: { intentId, provider: "simulated", processAfterMs: delayMs },
        });
      }

      await PaymentIntent.create(
        [
          {
            intentId,
            userId,
            flow,
            amount,
            status: "pending",
            processAfter,
            provider: flow === "withdraw" ? "simulated" : provider,
          },
        ],
        session ? { session } : {}
      );
    });
  } catch (e) {
    if (String(e.message) === "INSUFFICIENT_BALANCE") {
      return next(new ApiError("Insufficient balance", 400));
    }
    throw e;
  }

  const payload = {
    intentId,
    flow,
    amount,
    status: "pending",
    processAfter: processAfter ? processAfter.toISOString() : null,
    provider: flow === "withdraw" ? "simulated" : provider,
  };

  if (flow === "deposit" && provider === "stripe") {
    const stripeAmount = stripeMinorUnitsForChips(amount);
    const currency = (process.env.STRIPE_CURRENCY || "usd").toLowerCase();
    const pi = await stripe.paymentIntents.create({
      amount: stripeAmount,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        app_intent_id: intentId,
        user_id: String(userId),
      },
    });

    await PaymentIntent.updateOne(
      { intentId },
      {
        $set: {
          providerRef: pi.id,
          clientSecret: pi.client_secret,
          providerMeta: { currency, stripeStatus: pi.status },
        },
      }
    );

    payload.clientSecret = pi.client_secret;
    payload.publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || "";
    payload.providerRef = pi.id;
  }

  if (flow === "deposit" && provider === "crypto_usdt") {
    payload.crypto = {
      asset: "USDT",
      network: process.env.CRYPTO_USDT_NETWORK || "TRC20",
      address: process.env.CRYPTO_USDT_DEPOSIT_ADDRESS || "",
      memo: process.env.CRYPTO_USDT_MEMO || "",
      instructions: "Send the exact amount; crediting is manual or via processor webhook in production.",
    };
  }

  res.status(201).json({
    status: "success",
    data: payload,
  });
});

/**
 * confirmPayment(intentId) — simulated / withdraw completion. Stripe deposits complete via webhook only.
 */
exports.confirmPayment = asyncHandler(async (req, res, next) => {
  const intentId = String(req.body?.intentId || "").trim();
  if (!intentId) return next(new ApiError("intentId is required", 400));

  const userId = req.user._id;

  const existing = await PaymentIntent.findOne({ userId, intentId }).select("+clientSecret");
  if (!existing) {
    return next(new ApiError("Intent not found or already processed", 404));
  }

  if (existing.flow === "deposit" && existing.provider === "stripe") {
    const stripe = getStripe();
    let paymentStatus = "unknown";
    if (stripe && existing.providerRef) {
      const pi = await stripe.paymentIntents.retrieve(existing.providerRef);
      paymentStatus = pi.status;
      if (pi.status === "succeeded") {
        return res.status(200).json({
          status: "success",
          data: {
            intentId,
            paymentStatus,
            message: "Payment succeeded; wallet should already reflect the deposit.",
          },
        });
      }
    }
    return res.status(200).json({
      status: "success",
      data: {
        intentId,
        status: "pending",
        paymentStatus,
        message: "Complete card payment in the client; balance updates when Stripe notifies the server.",
      },
    });
  }

  if (existing.flow === "deposit" && existing.provider === "crypto_usdt") {
    return next(
      new ApiError("Crypto deposits are confirmed by the payment processor / ops — not via this endpoint", 400)
    );
  }

  try {
    const result = await withMongoTransaction(async (session) => {
      const intent = await PaymentIntent.findOne({
        userId,
        intentId,
        status: "pending",
      }).session(session);

      if (!intent) {
        throw new Error("INTENT_NOT_FOUND");
      }

      if (intent.flow === "withdraw" && intent.processAfter && Date.now() < intent.processAfter.getTime()) {
        throw new Error("WITHDRAW_NOT_READY");
      }

      if (intent.flow === "deposit" && simulatePaymentFailure()) {
        await appendBalancesUnchanged({
          session,
          userId,
          type: "failed_deposit",
          amount: intent.amount,
          meta: { intentId, reason: "simulated_failure" },
        });
        intent.status = "failed";
        intent.failureReason = "simulated_failure";
        intent.completedAt = new Date();
        await intent.save({ session });
        return { failed: true };
      }

      if (intent.flow === "deposit") {
        await ledgerDeposit({
          session,
          userId,
          amount: intent.amount,
          meta: { intentId, source: "payment_confirm" },
          ledgerType: "confirmed_deposit",
        });
        await recordDepositCompleted(userId, intent.amount);
        trackEventServerFireAndForget("deposit", userId, { intentId, amount: intent.amount, provider: "simulated" });
      } else {
        await assertCanWithdraw(userId, intent.amount);
        await ledgerWithdraw({
          session,
          userId,
          amount: intent.amount,
          meta: { intentId, source: "payment_confirm" },
          ledgerType: "completed_withdraw",
        });
        await recordWithdrawCompleted(userId, intent.amount);
        trackEventServerFireAndForget("withdraw", userId, { intentId, amount: intent.amount });
      }

      intent.status = "completed";
      intent.completedAt = new Date();
      await intent.save({ session });
      return { failed: false };
    });

    if (result.failed) {
      return next(new ApiError("Payment failed (simulated)", 402));
    }
  } catch (e) {
    if (String(e.message) === "INTENT_NOT_FOUND") {
      return next(new ApiError("Intent not found or already processed", 404));
    }
    if (String(e.message) === "WITHDRAW_NOT_READY") {
      return next(new ApiError("Withdraw is still processing; try again shortly", 425));
    }
    if (String(e.message) === "INSUFFICIENT_BALANCE") {
      return next(new ApiError("Insufficient balance", 400));
    }
    if (String(e.message) === "WITHDRAW_DAILY_LIMIT") {
      return next(new ApiError("Daily withdraw limit reached", 400));
    }
    if (String(e.message) === "TRUST_RESTRICTED") {
      return next(new ApiError("Account restricted — contact support", 403));
    }
    throw e;
  }

  const Wallet = require("../models/walletModel");
  const wallet = await Wallet.findOne({ user: userId });
  res.status(200).json({
    status: "success",
    data: {
      intentId,
      status: "completed",
      balance: wallet?.balance ?? 0,
      lockedBalance: wallet?.lockedBalance ?? 0,
      currency: wallet?.currency,
    },
  });
});
