const express = require("express");
const authService = require("../services/authService");

/**
 * The standalone legacy Tournament system (this file's real handlers, in
 * ../services/tournamentService.js + ../services/tournamentEngineService.js)
 * is disabled at this route layer only — see docs/SYSTEM_MONITORING_AUDIT.md
 * and docs/STANDALONE_TOURNAMENT_DISABLED.md for the full audit.
 *
 * Money-safety reason: registration debits the wallet via a non-transactional
 * legacy call before registration is confirmed, with no refund on failure,
 * and prizes are computed but never actually paid out. The real handlers,
 * engine, and model are intentionally left untouched (not deleted) so the
 * feature stays available for a future proper fix + migration — every route
 * below is redirected to a stub that never reaches that code, so the bug is
 * now structurally unreachable rather than patched in place.
 *
 * GET /lobby and GET / deliberately keep returning their normal EMPTY
 * success shape (not an error) rather than being rejected outright: it's the
 * one endpoint the live Flutter app still calls
 * (features/game/poker/kingtexas/mtt/poker_tournament_service.dart#fetchLobby),
 * and the collection is already always empty in production (nothing creates
 * a tournament), so this is a zero-observable-change disable for that screen.
 */

const router = express.Router();

function disabledEmptyList(paginated) {
  return (req, res) => {
    const base = { status: "success", results: 0, data: [] };
    if (paginated) {
      const page = parseInt(req.query.page || "1", 10);
      const limit = parseInt(req.query.limit || "20", 10);
      base.paginationResult = { currentPage: page, limit, numberOfPages: 0, next: null };
    }
    res.status(200).json(base);
  };
}

function disabledNotFound(req, res) {
  res.status(404).json({
    status: "error",
    message: "Tournament feature is currently unavailable",
  });
}

function disabledMutation(req, res) {
  res.status(410).json({
    status: "error",
    message: "Tournament registration is currently disabled",
  });
}

router.get("/", disabledEmptyList(true));

router.get("/lobby", disabledEmptyList(false));

router.get("/:id/statistics", disabledNotFound);

router.get("/:id", disabledNotFound);

router.post("/", authService.protect, authService.allowedTo("admin", "manager"), disabledMutation);

router.post("/:id/register", authService.protect, disabledMutation);

router.get("/:id/leaderboard", disabledNotFound);

module.exports = router;
