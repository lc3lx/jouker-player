const express = require("express");
const authService = require("../services/authService");
const {
  listTournaments,
  getTournament,
  createTournament,
  registerTournament,
  getLeaderboard,
} = require("../services/tournamentService");
const {
  createTournamentValidator,
  getTournamentValidator,
  registerTournamentValidator,
  listTournamentsValidator,
} = require("../utils/validators/tournamentValidator");

const router = express.Router();

router.get("/", listTournamentsValidator, listTournaments);

router.get("/:id", getTournamentValidator, getTournament);

router.post(
  "/",
  authService.protect,
  authService.allowedTo("admin", "manager"),
  createTournamentValidator,
  createTournament
);

router.post(
  "/:id/register",
  authService.protect,
  registerTournamentValidator,
  registerTournament
);

router.get(
  "/:id/leaderboard",
  getTournamentValidator,
  getLeaderboard
);

module.exports = router;
