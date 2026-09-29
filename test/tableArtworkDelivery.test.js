"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs/promises");
const sharp = require("sharp");
const { tableArtworkMiddleware } = require("../middlewares/tableArtworkMiddleware");
const { normalizeTableArtwork } = require("../utils/normalizeTableArtwork");

const serve = tableArtworkMiddleware(path.join(__dirname, "../assets"), "assets");
async function request(file, query = { tableArt: "3" }) {
  const response = { statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; },
    set(k, v) { this.headers[k] = v; return this; }, type(v) { this.contentType = v; return this; },
    send(v) { this.body = v; return this; }, end() { return this; } };
  await serve({ path: file, query, method: "GET" }, response, error => {
    if (error) throw error;
    response.passedThrough = true;
  });
  return response;
}

for (const file of ["tables/dragon_ice.png", "tables/wolf_night_clean.png", "tables/arabesque_palace.png",
  "vip/bronze/taple_vip_bronze.png", "vip/silver/taple_vip_silver.png", "vip/gold/taple_vip_golde.png", "vip/platinum/taple_vip_platinum.png"]) {
  test(`legacy ${file} arrives without matte or empty canvas, originals preserved`, async () => {
    const original = await fs.readFile(path.join(__dirname, "../assets", file));
    const result = await request('/' + file);
    assert.equal(result.statusCode, 200);
    assert.equal(result.contentType, "png");
    const { data, info } = await sharp(result.body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.ok(info.width / info.height > 1.3, "square VIP canvas must be tightly cropped");
    for (const i of [0, info.width - 1, (info.height - 1) * info.width, info.width * info.height - 1]) assert.equal(data[i * 4 + 3], 0, "no opaque corner blocks");
    assert.deepEqual(await fs.readFile(path.join(__dirname, "../assets", file)), original);
    assert.deepEqual((await request('/' + file)).body, result.body, "cached view is identical");
  });
}

test("ordinary images pass through and unsafe paths are rejected", async () => {
  assert.equal((await request('/tables/dragon_ice.png', {})).passedThrough, true);
  for (const file of ['/../server.js', '/tables/%2e%2e/server.png', '/skin/skin_1.png', '/tables/a\\b.png']) {
    assert.equal((await request(file)).statusCode, 404);
  }
});

test("admin upload rejects complex opaque backgrounds with a useful error", async () => {
  const source = await sharp({ create: { width: 24, height: 16, channels: 4, background: '#ab4789' } }).png().toBuffer();
  await assert.rejects(normalizeTableArtwork(source, { requireTransparentExterior: true }), error => error.statusCode === 400);
});
