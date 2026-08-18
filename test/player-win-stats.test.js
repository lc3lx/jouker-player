const test = require("node:test");
const assert = require("node:assert/strict");

const {
  safeGameType,
  buildStatsInc,
} = require("../services/playerWinStatsService");

test("safeGameType strips unsafe characters", () => {
  assert.equal(safeGameType("Poker"), "poker");
  assert.equal(safeGameType("golden-tree"), "golden-tree");
  assert.equal(safeGameType("sicbo!!"), "sicbo");
  assert.equal(safeGameType(""), "game");
});

test("buildStatsInc counts a win for the game and totals", () => {
  const inc = buildStatsInc({ won: true, gameType: "trix" });
  assert.equal(inc["stats.gamesPlayed"], 1);
  assert.equal(inc["stats.wins"], 1);
  assert.equal(inc["stats.byGame.trix.played"], 1);
  assert.equal(inc["stats.byGame.trix.wins"], 1);
});

test("buildStatsInc records a loss without incrementing wins", () => {
  const inc = buildStatsInc({ won: false, gameType: "sicbo" });
  assert.equal(inc["stats.gamesPlayed"], 1);
  assert.equal(inc["stats.wins"], undefined);
  assert.equal(inc["stats.byGame.sicbo.played"], 1);
  assert.equal(inc["stats.byGame.sicbo.wins"], undefined);
});
