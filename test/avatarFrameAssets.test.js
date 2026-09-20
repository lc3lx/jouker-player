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

test("the four VIP frames were added and are visible in the store", () => {
  const byKey = new Map(frameRows().map((r) => [r.assetKey, r]));
  for (const tier of ["bronze", "silver", "gold", "platinum"]) {
    const row = byKey.get(`skin_vip_${tier}`);
    assert.ok(row, `skin_vip_${tier} is missing from the catalog`);
    // `STORE_VISIBLE` filters on `vipLevelRequired: null`. Setting it here
    // would hide the frame from the store, and nothing grants VIP cosmetics
    // into an inventory yet — so it would simply never appear for anyone.
    assert.ok(
      row.vipLevelRequired == null,
      `skin_vip_${tier} sets vipLevelRequired, which hides it from the store`
    );
  }
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
