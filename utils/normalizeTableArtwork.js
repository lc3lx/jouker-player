"use strict";

const sharp = require("sharp");
const ApiError = require("./apiError");

/** Remove only neutral, edge-connected background; never key out interior ink.
 * Transparent sprites keep their alpha. Tight bounds let the client align the
 * actual rail with its seat layout instead of aligning an invisible canvas.
 */
async function normalizeTableArtwork(buffer) {
  const { data, info } = await sharp(buffer, { limitInputPixels: 40_000_000 })
    .rotate().resize(2048, 1024, { fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const count = width * height;
  const queue = new Int32Array(count);
  const visited = new Uint8Array(count);
  let head = 0, tail = 0;
  // Only remove an opaque matte if all opaque corners agree on near-black or
  // near-white. Colourful/complex backgrounds remain untouched.
  const corners = [0, width - 1, (height - 1) * width, count - 1];
  const tone = (i) => {
    const p = i * 4;
    if (data[p + 3] <= 8) return "clear";
    const lo = Math.min(data[p], data[p + 1], data[p + 2]);
    const hi = Math.max(data[p], data[p + 1], data[p + 2]);
    if (hi - lo > 8) return "other";
    return hi <= 16 ? "black" : lo >= 240 ? "white" : "other";
  };
  const opaqueTones = new Set(corners.map(tone).filter((v) => v !== "clear"));
  const matte = opaqueTones.size === 1 && !opaqueTones.has("other") ? [...opaqueTones][0] : null;
  const visit = (i) => {
    if (visited[i]) return;
    visited[i] = 1;
    const t = tone(i);
    if (t !== "clear" && t !== matte) return;
    data[i * 4 + 3] = 0;
    queue[tail++] = i;
  };
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
  while (head < tail) {
    const i = queue[head++], x = i % width;
    if (x > 0) visit(i - 1);
    if (x + 1 < width) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i + width < count) visit(i + width);
  }
  let left = width, right = -1, top = height, bottom = -1;
  for (let i = 0; i < count; i++) {
    if (data[i * 4 + 3] <= 8) continue;
    const x = i % width, y = Math.floor(i / width);
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) {
    throw new ApiError("Table artwork is empty after background cleanup; upload a visible table on transparency", 400);
  }
  return sharp(data, { raw: { width, height, channels: 4 } })
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .png().toBuffer();
}

module.exports = { normalizeTableArtwork };
