const { resolveSpin } = require("../games/poseidon/spinEngine");
const poseidon = require("../games/poseidon/constants");
const dice = require("../games/dice/DiceEngine");

function post(hypothesisId, location, message, data) {
  return fetch("http://127.0.0.1:7937/ingest/b9a00eef-7143-4edb-b1d5-038072464bf7", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "7d1f00",
    },
    body: JSON.stringify({
      sessionId: "7d1f00",
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
      runId: "pre-fix",
    }),
  }).catch(() => {});
}

function poseidonSample(n, bonus) {
  let hits = 0;
  let plaques = 0;
  let appliedHits = 0;
  let carried = 0;
  for (let i = 0; i < n; i += 1) {
    const spin = resolveSpin({ bonusMode: bonus });
    const r = poseidon.resolvePayoutMultiplier({
      baseWin: spin.baseWin,
      plaqueSum: spin.multiplierSum,
      carried: bonus ? carried : 0,
      isFreeSpin: bonus,
      bankCap: bonus ? poseidon.BONUS_BANK_CAP : Infinity,
    });
    if (bonus) carried = r.nextCarried;
    const win = spin.baseWin * r.applied;
    if (win > 0) hits += 1;
    if (spin.multiplierSum > 0) plaques += 1;
    if (win > 0 && r.applied > 1) appliedHits += 1;
  }
  return { hit: hits / n, plaques: plaques / n, appliedHits: appliedHits / n };
}

function zeusSample(n, bonus) {
  let hits = 0;
  let plaques = 0;
  let appliedHits = 0;
  let carried = 0;
  for (let i = 0; i < n; i += 1) {
    const spin = dice.spin(1, {
      isFreeSpin: bonus,
      freeSpinMultiplier: bonus ? carried : 0,
      serverSeed: bonus ? "zb" : "base",
      clientSeed: "probe",
      nonce: i,
    });
    if (bonus) carried = spin.multipliers.freeSpinTotal;
    if (spin.totalWin > 0) hits += 1;
    if (spin.multipliers.collected > 0) plaques += 1;
    if (spin.totalWin > 0 && spin.multipliers.applied > 1) appliedHits += 1;
  }
  return { hit: hits / n, plaques: plaques / n, appliedHits: appliedHits / n };
}

async function main() {
  const pb = poseidonSample(2000, false);
  const zb = zeusSample(2000, false);
  const pBuy = poseidonSample(800, true);
  const zBuy = zeusSample(800, true);
  await post("C", "tool/_debug_winrate.js", "base and bonus hit rates", {
    poseidonBase: pb,
    zeusBase: zb,
    poseidonBonus: pBuy,
    zeusBonus: zBuy,
    poseidonKeep: poseidon.PLAQUE_WIN_KEEP,
    zeusPayScale: dice.FREESPIN_PAY_SCALE,
    zeusBankCap: dice.BONUS_BANK_CAP,
    poseidonBankCap: poseidon.BONUS_BANK_CAP,
    poseidonCluster: poseidon.BONUS_CLUSTER_SCALE,
  });
  console.log("logged");
}

main();
