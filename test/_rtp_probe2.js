const fs = require("fs");
const path = require("path");

const constantsPath = path.join(__dirname, "../games/poseidon/constants.js");
const orig = fs.readFileSync(constantsPath, "utf8");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulate(minMatch, letterBand0) {
  const letter = `[${letterBand0}, ${(letterBand0 * 1.15).toFixed(2)}, ${(letterBand0 * 1.5).toFixed(2)}]`;
  let code = orig
    .replace(/const MIN_MATCH = \d+;/, `const MIN_MATCH = ${minMatch};`)
    .replace(/const LETTER_PAYS = Object.freeze\(\[[^\]]+\]\);/, `const LETTER_PAYS = Object.freeze(${letter});`);
  fs.writeFileSync(constantsPath, code);
  for (const k of Object.keys(require.cache)) {
    if (k.includes("poseidon")) delete require.cache[k];
  }
  const { resolveSpin } = require("../games/poseidon/spinEngine");
  const {
    appliedMultiplierFor,
    MAX_WIN_MULTIPLIER,
    FREE_SPINS_NATURAL,
    TRIGGER_MIN_MULTIPLIERS,
  } = require("../games/poseidon/constants");
  const rng = mulberry32(1234567);
  let totalBet = 0;
  let totalWon = 0;
  const winOf = (s, isBonus) => {
    const ap =
      s.baseWin > 0 && s.multiplierSum > 0
        ? appliedMultiplierFor(s.multiplierSum, isBonus)
        : 1;
    return Math.min(s.baseWin * ap, MAX_WIN_MULTIPLIER);
  };
  const playBonus = () => {
    let rem = FREE_SPINS_NATURAL;
    let won = 0;
    let guard = 0;
    while (rem > 0 && guard < 400) {
      guard += 1;
      rem -= 1;
      const s = resolveSpin({ bonusMode: true, rng });
      won += winOf(s, true);
      if (s.multipliers.length >= TRIGGER_MIN_MULTIPLIERS) rem += 5;
    }
    return won;
  };
  for (let i = 0; i < 30000; i += 1) {
    totalBet += 1;
    const s = resolveSpin({ rng });
    let win = winOf(s, false);
    if (s.multipliers.length >= TRIGGER_MIN_MULTIPLIERS) win += playBonus();
    totalWon += win;
  }
  return totalWon / totalBet;
}

for (const mm of [7, 8]) {
  for (const l of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.75, 1.0]) {
    console.log(
      `MIN_MATCH ${mm} letter7 ${l} rtp ${(simulate(mm, l) * 100).toFixed(1)}%`,
    );
  }
}
fs.writeFileSync(constantsPath, orig);
