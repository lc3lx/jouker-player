const crypto = require("crypto");

/**
 * Deterministic uniform [0,1) RNG from server-derived secret + clientSeed + nonce.
 * Uses HMAC-SHA256 in counter mode — same inputs always yield the same sequence.
 * @param {string} serverSeed
 * @param {string} clientSeed
 * @param {string} nonce
 * @returns {() => number}
 */
function createSeededRng(serverSeed, clientSeed, nonce) {
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
    const x = buf.readUInt32BE(idx) / 0xffffffff;
    idx += 4;
    return x;
  };
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

module.exports = { createSeededRng, sha256Hex };
