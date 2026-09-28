"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const path = require("path");
const { normalizeTableArtwork } = require("../utils/normalizeTableArtwork");

async function fixture(background) {
  const width = 16, height = 10;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    const rail = x >= 3 && x <= 12 && y >= 2 && y <= 7;
    const corner = (x === 3 || x === 12) && (y === 2 || y === 7);
    const rgb = rail && !corner ? [35, 85, 125, 255] : background;
    pixels.set(rgb, p);
  }
  // Black and white details enclosed by coloured rail must survive keying.
  pixels.set([0, 0, 0, 255], (4 * width + 7) * 4);
  pixels.set([255, 255, 255, 255], (4 * width + 8) * 4);
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

for (const [name, background] of [["black", [0, 0, 0, 255]], ["white", [255, 255, 255, 255]], ["transparent", [0, 0, 0, 0]]]) {
  test(`${name} exterior is removed, tightly cropped, and interior details survive`, async () => {
    const png = await normalizeTableArtwork(await fixture(background));
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 10);
    assert.equal(info.height, 6);
    assert.equal(info.channels, 4);
    assert.equal(data[3], 0, "transparent oval corner");
    assert.deepEqual([...data.subarray((2 * 10 + 4) * 4, (2 * 10 + 4) * 4 + 4)], [0, 0, 0, 255]);
    assert.deepEqual([...data.subarray((2 * 10 + 5) * 4, (2 * 10 + 5) * 4 + 4)], [255, 255, 255, 255]);
    assert.deepEqual(await normalizeTableArtwork(png), png, "normalization is idempotent");
  });
}

test("empty background is rejected instead of publishing an invisible table", async () => {
  const png = await sharp({ create: { width: 16, height: 10, channels: 4, background: "black" } }).png().toBuffer();
  await assert.rejects(() => normalizeTableArtwork(png), /artwork is empty/);
});

test("complex coloured backgrounds are preserved rather than erasing the table", async () => {
  const source = await fixture([160, 40, 70, 255]);
  const result = await normalizeTableArtwork(source);
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.width, 16);
  assert.equal(metadata.height, 10);
});

test("shipped clean sprites have transparent corners and tight non-empty bounds", async () => {
  for (const name of ["wolf_night_clean", "arabesque_palace"]) {
    const { data, info } = await sharp(path.join(__dirname, "../assets/tables", `${name}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const i of [0, info.width - 1, (info.height - 1) * info.width, info.width * info.height - 1]) assert.equal(data[i * 4 + 3], 0);
    for (const edge of [
      Array.from({ length: info.width }, (_, x) => x),
      Array.from({ length: info.width }, (_, x) => (info.height - 1) * info.width + x),
      Array.from({ length: info.height }, (_, y) => y * info.width),
      Array.from({ length: info.height }, (_, y) => y * info.width + info.width - 1),
    ]) assert.ok(edge.some((i) => data[i * 4 + 3] > 8), `${name}: no unused canvas border`);
  }
});

test("Middle Eastern table is purchasable for thirty million coins", () => {
  const table = require("../data/defaultCosmeticsCatalog").find((r) => r.assetKey === "arabesque_palace");
  assert.equal(table.price, 30_000_000);
  assert.equal(table.type, "table_theme");
  assert.equal(table.isActive, true);
  assert.deepEqual(table.games, ["poker"]);
});
