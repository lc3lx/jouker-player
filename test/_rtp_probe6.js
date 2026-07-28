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

function simulate(paytable, minMatch, multBase, capBase) {
  const pt = JSON.stringify(paytable, null, 2)
    .replace(/"([a-z]+)"/g, (m, k) => {
      const map = { crown: "SYMBOLS.CROWN", fish: "SYMBOLS.FISH", pearl: "SYMBOLS.PEARL", starfish: "SYMBOLS.STARFISH", coral: "SYMBOLS.CORAL" };
      return map[k] ? `[SYMBOLS.${k.toUpperCase()}]` : m;
    });
  let code = orig
    .replace(/const MIN_MATCH = \d+;/, `const MIN_MATCH = ${minMatch};`)
    .replace(/const LETTER_PAYS = Object.freeze\(\[[^\]]+\]\);/, `const LETTER_PAYS = Object.freeze([${paytable.letter.join(", ")}]);`)
    .replace(/\[SYMBOLS.CROWN\]: \[[^\]]+\],/, `[SYMBOLS.CROWN]: [${paytable.crown.join(", ")}],`)
    .replace(/\[SYMBOLS.FISH\]: \[[^\]]+\],/, `[SYMBOLS.FISH]: [${paytable.fish.join(", ")}],`)
    .replace(/\[SYMBOLS.PEARL\]: \[[^\]]+\],/, `[SYMBOLS.PEARL]: [${paytable.pearl.join(", ")}],`)
    .replace(/\[SYMBOLS.STARFISH\]: \[[^\]]+\],/, `[SYMBOLS.STARFISH]: [${paytable.starfish.join(", ")}],`)
    .replace(/\[SYMBOLS.CORAL\]: \[[^\]]+\],/, `[SYMBOLS.CORAL]: [${paytable.coral.join(", ")}],`)
    .replace(/const APPLIED_MULTIPLIER_CAP_BASE = \d+;/, `const APPLIED_MULTIPLIER_CAP_BASE = ${capBase};`)
    .replace(/ \["mult", [0-9.]+\],/, ` ["mult", ${multBase}],`);
  fs.writeFileSync(constantsPath, code);
  for (const k of Object.keys(require.cache)) if (k.includes("poseidon")) delete require.cache[k];
  const { resolveSpin } = require("../games/poseidon/spinEngine");
  const { appliedMultiplierFor, MAX_WIN_MULTIPLIER, FREE_SPINS_NATURAL, TRIGGER_MIN_MULTIPLIERS } = require("../games/poseidon/constants");
  const rng = mulberry32(1234567);
  let totalBet = 0, totalWon = 0;
  const winOf = (s, isBonus) => {
    const ap = s.baseWin > 0 && s.multiplierSum > 0 ? appliedMultiplierFor(s.multiplierSum, isBonus) : 1;
    return Math.min(s.baseWin * ap, MAX_WIN_MULTIPLIER);
  };
  const playBonus = () => {
    let rem = FREE_SPINS_NATURAL, won = 0, g = 0;
    while (rem > 0 && g < 400) {
      g++; rem--;
      const s = resolveSpin({ bonusMode: true, rng });
      won += winOf(s, true);
      if (s.multipliers.length >= TRIGGER_MIN_MULTIPLIERS) rem += 5;
    }
    return won;
  };
  for (let i = 0; i < 30000; i++) {
    totalBet++;
    const s = resolveSpin({ rng });
    let w = winOf(s, false);
    if (s.multipliers.length >= TRIGGER_MIN_MULTIPLIERS) w += playBonus();
    totalWon += w;
  }
  return totalWon / totalBet;
}

const user = {
  crown: [2.5, 3.75, 5],
  fish: [2, 3, 4.2],
  pearl: [1.75, 2.5, 3.5],
  starfish: [1.5, 2, 2.8],
  coral: [1.25, 1.6, 2.2],
  letter: [1, 1.15, 1.5],
};
const tuned = {
  crown: [1.2, 2.5, 5],
  fish: [1.15, 2, 4],
  pearl: [1.1, 1.7, 3.2],
  starfish: [1.08, 1.5, 2.5],
  coral: [1.04, 1.25, 2],
  letter: [1, 1.15, 1.5],
};

for (const capBonus of [12,18,25,30]) for (const [name, pt] of [["user", user], ["tuned", tuned]]) {
  for (const [mm, mb, cap] of [[7, 0.2, 3], [7, 0.15, 2], [7, 0.25, 4]]) {
    console.log(capBonus,name, "mm", mm, "mult", mb, "cap", cap, (simulate(pt, mm, mb, cap) * 100).toFixed(1) + "%");
  }
}
fs.writeFileSync(constantsPath, orig);
