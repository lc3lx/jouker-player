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

function simulate(opts) {
  let code = orig
    .replace(/const MIN_MATCH = \d+;/, `const MIN_MATCH = ${opts.minMatch};`)
    .replace(
      /const APPLIED_MULTIPLIER_CAP_BASE = \d+;/,
      `const APPLIED_MULTIPLIER_CAP_BASE = ${opts.capBase};`,
    )
    .replace(
      /const APPLIED_MULTIPLIER_CAP_BONUS = \d+;/,
      `const APPLIED_MULTIPLIER_CAP_BONUS = ${opts.capBonus};`,
    )
    .replace(/ \["mult", [0-9.]+\],/, ` ["mult", ${opts.multBase}],`)
    .replace(
      /BONUS_WEIGHTS = Object.freeze\([\s\S]*?\["mult", [0-9.]+\],/,
      (block) => block.replace(/ \["mult", [0-9.]+\],/, ` ["mult", ${opts.multBonus}],`),
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

const configs = [
  { minMatch: 8, capBase: 6, capBonus: 18, multBase: 0.55, multBonus: 1.65 },
  { minMatch: 8, capBase: 10, capBonus: 30, multBase: 1.5, multBonus: 3.5 },
  { minMatch: 8, capBase: 12, capBonus: 40, multBase: 2.0, multBonus: 4.5 },
  { minMatch: 8, capBase: 15, capBonus: 50, multBase: 2.5, multBonus: 5.5 },
  { minMatch: 7, capBase: 3, capBonus: 8, multBase: 0.25, multBonus: 0.8 },
  { minMatch: 7, capBase: 4, capBonus: 10, multBase: 0.35, multBonus: 1.0 },
];

for (const c of configs) {
  console.log(JSON.stringify(c), (simulate(c) * 100).toFixed(1) + "%");
}
fs.writeFileSync(constantsPath, orig);
