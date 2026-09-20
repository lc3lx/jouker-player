"use strict";

/**
 * Which felt a table shows.
 *
 * The store has been selling table themes that could not possibly appear:
 * `resolveActiveTableCosmetics` was handed `{ vipLevel }` per seat and nothing
 * else, so a theme a player had bought and equipped never reached the felt.
 * Only a seated VIP could change it.
 *
 * These are pure-function tests — no database, no sockets — because the rule is
 * pure and the bug was in the rule, not in the plumbing around it.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveActiveTableCosmetics,
} = require("../services/playerPublicCosmeticsService");
const { vipCosmeticsForLevel } = require("../config/vipCosmeticsConfig");

/** A VIP level that actually has a table theme configured, or null. */
function vipLevelWithTheme() {
  for (const level of ["diamond", "platinum", "gold", "silver", "bronze"]) {
    if (vipCosmeticsForLevel(level)?.tableTheme) return level;
  }
  return null;
}

test("an equipped theme reaches the felt", () => {
  // The headline regression. Against the old resolver this returns null and
  // the player sees nothing for the chips they spent.
  const result = resolveActiveTableCosmetics([
    { vipLevel: null, equippedTableTheme: "midnight_royal", seatIndex: 3 },
  ]);

  assert.equal(result.activeTableTheme, "midnight_royal");
  assert.equal(result.activeTableAsset, null, "a gradient key has no sprite");
});

test("no theme and no VIP leaves the felt alone", () => {
  const result = resolveActiveTableCosmetics([
    { vipLevel: null, equippedTableTheme: null, seatIndex: 0 },
    { vipLevel: null, seatIndex: 1 },
  ]);

  assert.equal(result.activeTableTheme, null);
  assert.equal(result.activeTableAsset, null);
});

test("an empty table leaves the felt alone", () => {
  assert.deepEqual(resolveActiveTableCosmetics([]), {
    activeTableTheme: null,
    activeTableAsset: null,
  });
  assert.deepEqual(resolveActiveTableCosmetics(null), {
    activeTableTheme: null,
    activeTableAsset: null,
  });
});

test("a seated VIP outranks an equipped theme", () => {
  const level = vipLevelWithTheme();
  if (!level) return; // no VIP level has a table theme configured

  const result = resolveActiveTableCosmetics([
    { vipLevel: null, equippedTableTheme: "midnight_royal", seatIndex: 0 },
    { vipLevel: level, equippedTableTheme: null, seatIndex: 4 },
  ]);

  assert.equal(
    result.activeTableTheme,
    vipCosmeticsForLevel(level).tableTheme,
    "the paid perk stays on top"
  );
});

test("the highest VIP wins among several", () => {
  const high = vipLevelWithTheme();
  if (!high || high === "bronze") {
    const result = resolveActiveTableCosmetics([
      { vipLevel: "bronze", seatIndex: 0 },
      { vipLevel: high, seatIndex: 1 },
    ]);
    assert.equal(result.activeTableTheme, vipCosmeticsForLevel(high).tableTheme);
    return;
  }

  const result = resolveActiveTableCosmetics([
    { vipLevel: high, seatIndex: 5 },
    { vipLevel: "bronze", seatIndex: 0 },
  ]);
  assert.equal(
    result.activeTableTheme,
    vipCosmeticsForLevel(high).tableTheme,
    "seat order does not beat rank"
  );
});

test("the lowest seat wins when two players both have a theme", () => {
  const result = resolveActiveTableCosmetics([
    { vipLevel: null, equippedTableTheme: "burgundy_velvet", seatIndex: 5 },
    { vipLevel: null, equippedTableTheme: "midnight_royal", seatIndex: 2 },
  ]);

  assert.equal(result.activeTableTheme, "midnight_royal");
});

test("the answer does not depend on the order seats arrive in", () => {
  // Same table, rows shuffled. A felt that flips as unrelated state moves
  // around would flicker on every broadcast.
  const rows = [
    { vipLevel: null, equippedTableTheme: "burgundy_velvet", seatIndex: 5 },
    { vipLevel: null, equippedTableTheme: "midnight_royal", seatIndex: 2 },
    { vipLevel: null, equippedTableTheme: "obsidian_gold", seatIndex: 7 },
  ];

  const forward = resolveActiveTableCosmetics(rows);
  const reversed = resolveActiveTableCosmetics([...rows].reverse());

  assert.equal(forward.activeTableTheme, "midnight_royal");
  assert.deepEqual(forward, reversed);
});

test("a seat with no index does not beat one that has an index", () => {
  const result = resolveActiveTableCosmetics([
    { vipLevel: null, equippedTableTheme: "burgundy_velvet" },
    { vipLevel: null, equippedTableTheme: "midnight_royal", seatIndex: 9 },
  ]);

  assert.equal(
    result.activeTableTheme,
    "midnight_royal",
    "an unknown seat sorts last rather than winning by accident"
  );
});

test("a VIP level with no configured theme falls through to an equipped one", () => {
  // Levels are admin-configured, so a level with no table theme is possible.
  // It must not swallow the table and leave everyone on the default felt.
  const result = resolveActiveTableCosmetics([
    { vipLevel: "__nonexistent__", equippedTableTheme: null, seatIndex: 0 },
    { vipLevel: null, equippedTableTheme: "midnight_royal", seatIndex: 1 },
  ]);

  assert.equal(result.activeTableTheme, "midnight_royal");
});
