/**
 * Avatar frames are positioned by a contract the image itself has to honour.
 *
 * `ProfileAvatarFrameLayout` says it outright: "We scale the PNG so the hole
 * matches the photo." The client scales the whole 1080×1080 canvas until the
 * *hole* — the transparent opening in the middle — is the size of the avatar
 * photo, using one global pair of fractions for every frame. A frame supplied
 * at its own natural size, or with its opening off centre, therefore renders
 * several times too large or visibly shifted, and nothing anywhere throws.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SKIN_DIR = path.join(__dirname, "..", "assets", "skin");
const CATALOG = require("../data/defaultCosmeticsCatalog");

/** Width/height from a PNG's IHDR. */
function pngSize(file) {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, 24, 0);
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The bounding box of the visible art inside the 1080 canvas, as a fraction.
 *
 * This is what decides how big a frame looks: the client scales the canvas
 * until the frame's *hole* matches the avatar photo, so art that is large
 * relative to its opening ends up larger on screen than its neighbours.
 */
function artBox(file) {
  const sharp = require("sharp");
  const { data, info } = sharpSync(sharp, file);
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  const ch = info.channels;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * ch + (ch - 1)] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { w: 0, h: 0 };
  return { w: (maxX - minX + 1) / info.width, h: (maxY - minY + 1) / info.height };
}

/** sharp is async-only; these are small files and the suite is synchronous. */
const _pixelCache = new Map();
function sharpSync(sharp, file) {
  if (_pixelCache.has(file)) return _pixelCache.get(file);
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(
    process.execPath,
    ["-e",
     `const s=require(${JSON.stringify(require.resolve("sharp"))});` +
     `s(process.argv[1]).ensureAlpha().raw().toBuffer({resolveWithObject:true})` +
     `.then(r=>{process.stdout.write(JSON.stringify({info:r.info,data:r.data.toString("base64")}))});`,
     file],
    { maxBuffer: 1 << 28 }
  );
  const parsed = JSON.parse(out.toString());
  const res = { data: Buffer.from(parsed.data, "base64"), info: parsed.info };
  _pixelCache.set(file, res);
  return res;
}

function frameRows() {
  return CATALOG.filter(
    (row) => row.type === "avatar_frame" && row.isActive !== false
  );
}

test("every active avatar frame in the catalog has its file", () => {
  const missing = [];
  for (const row of frameRows()) {
    const file = row.promoMeta?.skinFile || row.previewImage;
    assert.ok(file, `${row.assetKey} has no skin file at all`);
    const name = String(file).split("/").pop();
    if (!fs.existsSync(path.join(SKIN_DIR, name))) missing.push(row.assetKey);
  }
  assert.deepEqual(
    missing,
    [],
    `on sale with no image in the repo: ${missing.join(", ")}`
  );
});

test("every avatar frame is on the 1080 canvas the layout assumes", () => {
  // A frame handed over at its own size renders roughly 1/0.238 ≈ 4× too big,
  // because the client scales the canvas, not the artwork.
  const wrong = [];
  for (const row of frameRows()) {
    const file = row.promoMeta?.skinFile || row.previewImage;
    const name = String(file).split("/").pop();
    const p = path.join(SKIN_DIR, name);
    if (!fs.existsSync(p)) continue;
    const { width, height } = pngSize(p);
    if (width !== 1080 || height !== 1080) {
      wrong.push(`${row.assetKey} (${width}×${height})`);
    }
  }
  assert.deepEqual(wrong, [], `not 1080×1080: ${wrong.join(", ")}`);
});

test("the VIP frames come with the subscription and are not on sale", () => {
  // They were briefly listed for coins beside the ordinary frames, which is
  // what "اطارات تبع ال vip نزلو للبيع ما بصير ينباعو مع الاطارات" was about.
  // `STORE_VISIBLE` filters on `vipLevelRequired: null`, so setting the tier
  // both gates the item and keeps it out of the store; `vipHeldItems` lends it
  // to the tiers that qualify.
  const byKey = new Map(frameRows().map((r) => [r.assetKey, r]));
  for (const tier of ["bronze", "silver", "gold", "platinum"]) {
    const row = byKey.get(`skin_vip_${tier}`);
    assert.ok(row, `skin_vip_${tier} is missing from the catalog`);
    assert.equal(
      row.vipLevelRequired,
      tier,
      `skin_vip_${tier} is not gated to its tier, so it is on sale`
    );
    assert.equal(row.price, 0, `skin_vip_${tier} still carries a price`);
  }
});

test("no VIP-gated item anywhere carries a price", () => {
  const priced = CATALOG.filter((r) => r.vipLevelRequired && r.price > 0).map(
    (r) => `${r.type}:${r.assetKey}`
  );
  assert.deepEqual(priced, [], `for sale despite being VIP: ${priced.join(", ")}`);
});

test("every VIP tier has a felt, a card back and a frame to turn on", () => {
  // Without a catalog row there is nothing to own, equip or unequip — which is
  // why a subscriber could not find their VIP items at all.
  for (const tier of ["bronze", "silver", "gold", "platinum"]) {
    for (const [type, key] of [
      ["table_theme", `vip_${tier}`],
      ["card_skin", `vip_${tier}`],
      ["avatar_frame", `skin_vip_${tier}`],
    ]) {
      const row = CATALOG.find(
        (r) => r.type === type && r.assetKey === key && r.isActive !== false
      );
      assert.ok(row, `${tier}: no active ${type} row for ${key}`);
      assert.equal(row.vipLevelRequired, tier, `${type} ${key} is not gated`);
    }
  }
});

test("no frame is conspicuously bigger than the others", () => {
  // The client scales the canvas until the frame's *hole* matches the avatar
  // photo, so a frame whose opening is small relative to its art renders
  // larger than everything beside it — platinum came out 1.75× the rest.
  const sizes = [];
  for (const row of frameRows()) {
    const file = row.promoMeta?.skinFile || row.previewImage;
    const p = path.join(SKIN_DIR, String(file).split("/").pop());
    if (!fs.existsSync(p)) continue;
    sizes.push({ key: row.assetKey, ...artBox(p) });
  }
  assert.ok(sizes.length > 20, "sanity: measured a meaningful sample");
  const median = [...sizes].sort((a, b) => a.w - b.w)[Math.floor(sizes.length / 2)].w;
  const outliers = sizes
    .filter((s) => s.w > median * 1.35 || s.h > median * 1.45)
    .map((s) => `${s.key} (${(s.w / median).toFixed(2)}×)`);
  assert.deepEqual(outliers, [], `out of scale: ${outliers.join(", ")}`);
});

test("a frame's preview and its equipped art are the same file", () => {
  // The store card and the table seat read different fields. When they
  // disagree, players buy one picture and wear another.
  for (const row of frameRows()) {
    if (!row.promoMeta?.skinFile) continue;
    assert.equal(
      row.previewImage,
      row.promoMeta.skinFile,
      `${row.assetKey} previews a different file than it equips`
    );
  }
});

console.log("avatarFrameAssets.test.js: all tests registered");
