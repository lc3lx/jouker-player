"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { equippedTableForGame } = require("../utils/tableArtworkGames");

test("poker-only artwork is excluded from both portrait card games", () => {
  const table = { tableTheme: "wolf", tableAsset: "/wolf.png", tableGames: ["poker"] };
  for (const game of ["trix", "tarneeb41"]) {
    assert.deepEqual(equippedTableForGame(table, game), {
      equippedTableTheme: null, equippedTableAsset: null,
    });
  }
  assert.equal(equippedTableForGame(table, "poker").equippedTableAsset, "/wolf.png");
});

test("legacy and explicitly universal tables remain usable", () => {
  for (const tableGames of [undefined, [], ["all"]]) {
    assert.equal(equippedTableForGame({ tableTheme: "classic", tableGames }, "trix").equippedTableTheme, "classic");
  }
});
