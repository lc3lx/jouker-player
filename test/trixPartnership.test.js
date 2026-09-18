/**
 * تركس شركة — partnership trix.
 *
 * Researched difference from the individual game (اليهودية): there is exactly
 * one. Facing players are partners and their scores are summed; the five
 * contracts, their penalties, the kingdom rotation and the Trix finishing
 * ladder are identical. So both modes run on one engine and one gameType, and
 * only the unit that wins the دق changes.
 *
 * These lock that down: the engine reports a team, settlement pays the pair,
 * and a solo table is untouched by any of it.
 */
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const TrixGame = require("../games/trix/TrixGame");
const { resolveWinnerSeatIndices } = require("../services/gameSettlementService");

function gameWith(scores, { gameMode = "solo" } = {}) {
  const g = new TrixGame("trix_table_test", { gameMode });
  g.gameState = { scores: [...scores], finishedPlayers: [] };
  return g;
}

test("a table defaults to the individual game", () => {
  const g = new TrixGame("trix_table_test");
  assert.equal(g.gameMode, "solo");
  assert.equal(g.isPartnership, false);
});

test("an unknown mode falls back to solo rather than inventing one", () => {
  assert.equal(new TrixGame("r", { gameMode: "teams" }).gameMode, "solo");
  assert.equal(new TrixGame("r", { gameMode: null }).gameMode, "solo");
  assert.equal(new TrixGame("r", { gameMode: "partnership" }).gameMode, "partnership");
});

test("solo still crowns the single highest seat", () => {
  const g = gameWith([-100, -40, -250, -90]);
  const result = g.getGameResult();
  assert.equal(result.gameMode, "solo");
  assert.equal(result.winnerIndex, 1);
  assert.equal(result.winnerTeam, undefined, "solo must not report a team");
});

test("partnership sums facing seats and crowns the pair", () => {
  // Seats 0+2 = -260, seats 1+3 = -130. The second pair lost less, so it wins.
  const g = gameWith([-200, -100, -60, -30], { gameMode: "partnership" });
  const result = g.getGameResult();

  assert.equal(result.gameMode, "partnership");
  assert.deepEqual(result.teamScores, [-260, -130]);
  assert.equal(result.winnerTeam, 1);
});

test("the seat with the best individual score can be on the losing pair", () => {
  // Seat 2 scores best of anyone, but its partner sank the pair.
  const g = gameWith([-400, -90, -10, -95], { gameMode: "partnership" });
  const result = g.getGameResult();

  assert.equal(result.winnerIndex, 2, "the best individual seat is still seat 2");
  assert.deepEqual(result.teamScores, [-410, -185]);
  assert.equal(result.winnerTeam, 1, "but the pair it sits on lost");
});

test("a dead tie names no winning pair", () => {
  const g = gameWith([-100, -70, -50, -80], { gameMode: "partnership" });
  const result = g.getGameResult();
  assert.deepEqual(result.teamScores, [-150, -150]);
  assert.equal(result.winnerTeam, null);
});

test("settlement pays both partners, not just the higher scorer", () => {
  const g = gameWith([-400, -90, -10, -95], { gameMode: "partnership" });
  const winners = resolveWinnerSeatIndices("trix", g.getGameResult(), 4);
  assert.deepEqual(winners, [1, 3]);
});

test("settlement on a tie pays nobody, so every seat is refunded", () => {
  const g = gameWith([-100, -70, -50, -80], { gameMode: "partnership" });
  assert.deepEqual(resolveWinnerSeatIndices("trix", g.getGameResult(), 4), []);
});

test("settlement for a solo table is unchanged", () => {
  const g = gameWith([-100, -40, -250, -90]);
  assert.deepEqual(resolveWinnerSeatIndices("trix", g.getGameResult(), 4), [1]);
});

test("a solo tie at the top still pays every tied seat", () => {
  const g = gameWith([-40, -40, -250, -90]);
  assert.deepEqual(resolveWinnerSeatIndices("trix", g.getGameResult(), 4), [0, 1]);
});

test("the state packet carries the mode so the client can pair the seats", () => {
  const solo = gameWith([-1, -2, -3, -4]);
  const pair = gameWith([-1, -2, -3, -4], { gameMode: "partnership" });

  assert.equal(solo.teamScores().length, 2);
  assert.deepEqual(pair.teamScores(), [-4, -6]);

  assert.equal(solo.getRoundResult().gameMode, "solo");
  assert.equal(solo.getRoundResult().teamScores, null);
  assert.deepEqual(pair.getRoundResult().teamScores, [-4, -6]);
});
