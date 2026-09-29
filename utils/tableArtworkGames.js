"use strict";

function equippedTableForGame(equipped, game) {
  const row = equipped || {};
  const games = row.tableGames;
  const allowed = !Array.isArray(games) || games.length === 0 || games.includes("all") || games.includes(game);
  return {
    equippedTableTheme: allowed ? row.tableTheme || null : null,
    equippedTableAsset: allowed ? row.tableAsset || null : null,
  };
}

module.exports = { equippedTableForGame };
