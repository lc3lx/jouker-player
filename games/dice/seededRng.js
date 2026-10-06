const crypto = require("crypto");

/**
 * Deterministic uniform RNG from server-derived secret + clientSeed + nonce.
 * Uses HMAC-SHA256 in counter mode — same inputs always yield the same sequence.
 *
 * Engines up to v4 divide by 0xffffffff, which can return exactly 1.0 and push
 * a weighted pick past its last bucket. v5+ pass `{ exclusive: true }` for a
 * true [0, 1); older versions keep the original divisor so their spins still
 * replay identically for fairness verification.
 * @param {string} serverSeed
 * @param {string} clientSeed
 * @param {string} nonce
 * @param {{ exclusive?: boolean }} [options]
 * @returns {() => number}
 */
function createSeededRng(serverSeed, clientSeed, nonce, { exclusive = false } = {}) {
  const divisor = exclusive ? 2 ** 32 : 0xffffffff;
  let counter = 0;
  let buf = Buffer.alloc(0);
  let idx = 0;

  return function nextUnit() {
    if (idx + 4 > buf.length) {
      const h = crypto.createHmac("sha256", String(serverSeed));
      h.update(String(clientSeed));
      h.update("|");
      h.update(String(nonce));
      h.update("|");
      h.update(String(counter));
      counter += 1;
      buf = h.digest();
      idx = 0;
    }
    const x = buf.readUInt32BE(idx) / divisor;
    idx += 4;
    return x;
  };
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

module.exports = { createSeededRng, sha256Hex };
