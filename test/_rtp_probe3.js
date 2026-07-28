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

function simulate(minMatch, scale) {
  const pays = {
    CROWN: [2.5, 3.75, 5.0],
    FISH: [2.0, 3.0, 4.2],
    PEARL: [1.75, 2.5, 3.5],
    STARFISH: [1.5, 2.0, 2.8],
    CORAL: [1.25, 1.6, 2.2],
    LETTER: [1.0, 1.15, 1.5],
  };
  const s = (arr) =>
    `[${arr.map((v) => Math.round(v * scale * 100) / 100).join(", ")}]`;
  let code = orig
    .replace(/const MIN_MATCH = \d+;/, `const MIN_MATCH = ${minMatch};`)
    .replace(
      /const LETTER_PAYS = Object.freeze\(\[[^\]]+\]\);/,
      `const LETTER_PAYS = Object.freeze(${s(pays.LETTER)});`,
    )
    .replace(
      /\[SYMBOLS.CROWN\]: \[[^\]]+\],/,
      `[SYMBOLS.CROWN]: ${s(pays.CROWN)},`,
    )
    .replace(
      /\[SYMBOLS.FISH\]: \[[^\]]+\],/,
      `[SYMBOLS.FISH]: ${s(pays.FISH)},`,
    )
    .replace(
      /\[SYMBOLS.PEARL\]: \[[^\]]+\],/,
      `[SYMBOLS.PEARL]: ${s(pays.PEARL)},`,
    )
    .replace(
      /\[SYMBOLS.STARFISH\]: \[[^\]]+\],/,
      `[SYMBOLS.STARFISH]: ${s(pays.STARFISH)},`,
    )
    .replace(
      /\[SYMBOLS.CORAL\]: \[[^\]]+\],/,
      `[SYMBOLS.CORAL]: ${s(pays.CORAL)},`,
    );
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
  for (const sc of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1.0, 1.2, 1.5, 1.8, 2.0]) {
    const r = simulate(mm, sc);
    if (r > 0.75 && r < 1.05) {
      console.log(`MIN_MATCH ${mm} scale ${sc} rtp ${(r * 100).toFixed(1)}% ***`);
    }
  }
}
fs.writeFileSync(constantsPath, orig);
