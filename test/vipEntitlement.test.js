/**
 * VIP cosmetics: held, not granted — and chosen, not imposed.
 *
 * Reported as: "لما شخص vip خلي السكن تبعو والطاولة والكرت يطلعو عندو ويقدر
 * يطفيون ويشلغون او يبدلو ولما كون جوى الطاولة اقدر غير الطاولة وتتغير عند كل
 * اللاعبين، الاولوية بالظهور لل vip".
 *
 * Those two sentences pull in opposite directions unless VIP priority means
 * *whose choice decides the felt*, rather than *which picture is forced*. That
 * reading is what these tests pin down.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  vipRank,
  entitles,
  isVipGated,
  canEquip,
  isPurchasable,
  resolveTableFelt,
} = require("../services/vipEntitlementService");

const VIP_ART = {
  bronze: { tableTheme: "vip_bronze", tableAsset: "vip/bronze/t.png" },
  gold: { tableTheme: "vip_gold", tableAsset: "vip/gold/t.png" },
  platinum: { tableTheme: "vip_platinum", tableAsset: "vip/platinum/t.png" },
};
const vipArtFor = (level) => VIP_ART[String(level || "").toLowerCase()] || null;

// ── tiers ─────────────────────────────────────────────────────────────────

test("tiers rank upward and a non-subscriber ranks zero", () => {
  assert.equal(vipRank(null), 0);
  assert.equal(vipRank("nonsense"), 0);
  assert.ok(vipRank("bronze") < vipRank("silver"));
  assert.ok(vipRank("silver") < vipRank("gold"));
  assert.ok(vipRank("gold") < vipRank("platinum"));
});

test("a higher tier is entitled to everything below it", () => {
  assert.equal(entitles("platinum", "bronze"), true);
  assert.equal(entitles("gold", "gold"), true);
  assert.equal(entitles("bronze", "gold"), false);
  assert.equal(entitles(null, "bronze"), false);
});

test("an item with no tier is not a VIP item", () => {
  assert.equal(isVipGated({ assetKey: "rose_pink" }), false);
  assert.equal(isVipGated({ vipLevelRequired: null }), false);
  assert.equal(isVipGated({ vipLevelRequired: "gold" }), true);
  // Nothing is entitled by a requirement nobody can meet.
  assert.equal(entitles("platinum", "diamond"), false);
});

// ── holding vs owning ─────────────────────────────────────────────────────

test("a subscriber equips VIP art without ever owning it", () => {
  // Nothing is written on subscribe, so it is never in ownedItems. Requiring
  // ownership here is what made the VIP items unreachable.
  const item = { vipLevelRequired: "gold" };
  assert.equal(canEquip({ item, isOwned: false, vipLevel: "gold" }), true);
  assert.equal(canEquip({ item, isOwned: false, vipLevel: "platinum" }), true);
});

test("the entitlement lapses with the subscription, on its own", () => {
  const item = { vipLevelRequired: "gold" };
  assert.equal(canEquip({ item, isOwned: false, vipLevel: "silver" }), false);
  assert.equal(canEquip({ item, isOwned: false, vipLevel: null }), false);
});

test("a bought item still needs to be owned, VIP or not", () => {
  const item = { vipLevelRequired: null };
  assert.equal(canEquip({ item, isOwned: false, vipLevel: "platinum" }), false);
  assert.equal(canEquip({ item, isOwned: true, vipLevel: null }), true);
});

test("VIP items are never for sale", () => {
  assert.equal(isPurchasable({ vipLevelRequired: "bronze" }), false);
  assert.equal(isPurchasable({ vipLevelRequired: null }), true);
});

// ── the shared felt ───────────────────────────────────────────────────────

test("a VIP with nothing equipped shows their tier felt", () => {
  const out = resolveTableFelt(
    [{ vipLevel: "gold", seatIndex: 0 }],
    vipArtFor
  );
  assert.equal(out.activeTableTheme, "vip_gold");
  assert.equal(out.activeTableAsset, "vip/gold/t.png");
});

test("a VIP who equips a felt changes the table to it", () => {
  // The headline request. The old rule returned the tier felt here, so a
  // subscriber could not change the table at all.
  const out = resolveTableFelt(
    [{ vipLevel: "gold", equippedTableTheme: "dragon_ice", seatIndex: 0 }],
    vipArtFor
  );
  assert.equal(out.activeTableTheme, "dragon_ice");
  assert.equal(out.activeTableAsset, null, "a store felt has no sprite path");
});

test("the VIP's choice outranks another player's equipped felt", () => {
  const out = resolveTableFelt(
    [
      { seatIndex: 0, equippedTableTheme: "emerald_deep" },
      { seatIndex: 5, vipLevel: "gold", equippedTableTheme: "wolf_night" },
    ],
    vipArtFor
  );
  assert.equal(out.activeTableTheme, "wolf_night");
});

test("the highest tier decides, not the first one seated", () => {
  const out = resolveTableFelt(
    [
      { seatIndex: 0, vipLevel: "bronze", equippedTableTheme: "emerald_deep" },
      { seatIndex: 7, vipLevel: "platinum", equippedTableTheme: "carbon_elite" },
    ],
    vipArtFor
  );
  assert.equal(out.activeTableTheme, "carbon_elite");
});

test("a VIP who unequips hands the table back to their tier felt", () => {
  // "يقدر يطفيون" — turning it off has to be a real state, not a no-op.
  const seats = [{ vipLevel: "bronze", seatIndex: 2 }];
  assert.equal(resolveTableFelt(seats, vipArtFor).activeTableTheme, "vip_bronze");
});

test("with no VIP seated the lowest seat with a felt wins, every time", () => {
  const seats = [
    { seatIndex: 6, equippedTableTheme: "carbon_elite" },
    { seatIndex: 2, equippedTableTheme: "marble_ivory" },
    { seatIndex: 4, equippedTableTheme: "desert_sand" },
  ];
  const first = resolveTableFelt(seats, vipArtFor).activeTableTheme;
  assert.equal(first, "marble_ivory");
  // Order-independent: the felt must not flicker as unrelated state moves.
  const shuffled = [seats[2], seats[0], seats[1]];
  assert.equal(resolveTableFelt(shuffled, vipArtFor).activeTableTheme, first);
});

test("an empty table has no felt and does not throw", () => {
  assert.deepEqual(resolveTableFelt([], vipArtFor), {
    activeTableTheme: null,
    activeTableAsset: null,
  });
  assert.deepEqual(resolveTableFelt(null, vipArtFor), {
    activeTableTheme: null,
    activeTableAsset: null,
  });
});

console.log("vipEntitlement.test.js: all tests registered");
