/**
 * VIP card backs are rendered with `BoxFit.cover` into the card slot, so the
 * file's own framing decides how big the card looks.
 *
 * All eight shipped as 1080×1080 canvases with the card itself occupying about
 * 22% of the width and the rest fully transparent. Cover filled the slot with
 * the canvas, which meant the visible card came out roughly a third of the size
 * of an ordinary card back — reported as "كروت الـVIP حجمون أصغر من الكروت
 * العادية". Nothing logged it, because nothing was wrong at the code level.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const VIP_DIR = path.join(__dirname, "..", "assets", "vip");

/** Width/height from a PNG's IHDR, which is always the first chunk. */
function pngSize(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    assert.equal(
      head.subarray(1, 4).toString("ascii"),
      "PNG",
      `${file} is not a PNG`
    );
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

function cardAssets() {
  if (!fs.existsSync(VIP_DIR)) return [];
  const out = [];
  for (const tier of fs.readdirSync(VIP_DIR)) {
    const dir = path.join(VIP_DIR, tier);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (/^cards\d+_vip_.+\.png$/i.test(name)) {
        out.push({ tier, name, file: path.join(dir, name) });
      }
    }
  }
  return out;
}

// The slot these are drawn into: KingTexasDesign.cardW / cardH = 66 / 92.
const SLOT_ASPECT = 66 / 92;

test("the VIP card assets are present", () => {
  assert.ok(
    cardAssets().length >= 8,
    "expected two card backs for each of the four VIP tiers"
  );
});

test("no VIP card back is a padded square canvas", () => {
  // This is the exact shape of the bug: a 1080×1080 frame holding a small card.
  const square = cardAssets()
    .filter(({ file }) => {
      const { width, height } = pngSize(file);
      return width === height;
    })
    .map((c) => `${c.tier}/${c.name}`);

  assert.deepEqual(
    square,
    [],
    `these are square canvases, so the card inside renders far smaller than an ordinary back: ${square.join(", ")}`
  );
});

test("every VIP card back is shaped like a card", () => {
  // Cover crops the overflow, so a file far off the slot's ratio loses its
  // border. Allow a reasonable band around 0.717 and name anything outside it.
  const bad = [];
  for (const { tier, name, file } of cardAssets()) {
    const { width, height } = pngSize(file);
    const aspect = width / height;
    if (aspect < 0.62 || aspect > 0.86) {
      bad.push(`${tier}/${name} (${width}×${height}, aspect ${aspect.toFixed(3)})`);
    }
  }
  assert.deepEqual(bad, [], `not card-shaped: ${bad.join(", ")}`);
});

test("a VIP back is portrait, never landscape", () => {
  for (const { tier, name, file } of cardAssets()) {
    const { width, height } = pngSize(file);
    assert.ok(height > width, `${tier}/${name} is not portrait`);
  }
});

test("the slot ratio the assets are checked against is the one in the app", () => {
  // If KingTexasDesign.cardW/cardH ever changes, this is the reminder that the
  // band above was chosen around it.
  assert.ok(Math.abs(SLOT_ASPECT - 0.717) < 0.002);
});

console.log("vipCardAssets.test.js: all tests registered");
