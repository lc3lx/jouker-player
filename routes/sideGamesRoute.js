const express = require("express");
const authService = require("../services/authService");
const { listTypes } = require("../services/sideGamesService");
const { listValidator } = require("../utils/validators/sideGamesValidator");
const ApiError = require("../utils/apiError");

const router = express.Router();

router.get("/", listValidator, listTypes);

// Non-ledger RNG money path — disabled (same posture as legacy MTT).
// Flutter has no callers; re-enable only behind walletLedgerService.
router.post("/play", authService.protect, (req, res, next) => {
  // #region agent log
  try {
    fetch("http://127.0.0.1:7937/ingest/b9a00eef-7143-4edb-b1d5-038072464bf7", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "4de1a0",
      },
      body: JSON.stringify({
        sessionId: "4de1a0",
        hypothesisId: "B",
        location: "sideGamesRoute.js:play",
        message: "blocked unsafe side-games play",
        data: { userId: String(req.user?._id || "") },
        timestamp: Date.now(),
        runId: "prod-hardening",
      }),
    }).catch(() => {});
  } catch (_) {}
  // #endregion
  next(
    new ApiError(
      "Side games play is disabled. Use Poseidon / Golden Tree / Sic Bo instead.",
      410
    )
  );
});

module.exports = router;
