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

function zeusBaseRtp(n) {
  let win = 0;
  let hits = 0;
  let multHits = 0;
  for (let i = 0; i < n; i += 1) {
    const spin = dice.spin(1, {
      isFreeSpin: false,
      serverSeed: "rtp",
      clientSeed: "probe",
      nonce: i,
    });
    win += spin.totalWin;
    if (spin.totalWin > 0) hits += 1;
    if (spin.totalWin > 0 && spin.multipliers.applied > 1) multHits += 1;
  }
  return {
    rtp: Math.round((win / n) * 10000) / 10000,
    hit: Math.round((hits / n) * 10000) / 10000,
    multHit: Math.round((multHits / n) * 10000) / 10000,
  };
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

function zeusBuy(rounds) {
  let win = 0;
  let appliedSum = 0;
  let appliedN = 0;
  let clipped = 0;
  let winning = 0;
  const returns = [];
  const spins = rounds * dice.FREE_SPINS_BOUGHT;
  for (let i = 0; i < rounds; i += 1) {
    let carried = 0;
    let session = 0;
    for (let s = 0; s < dice.FREE_SPINS_BOUGHT; s += 1) {
      const spin = dice.spin(1, {
        isFreeSpin: true,
        freeSpinMultiplier: carried,
        serverSeed: "buy",
        clientSeed: "probe",
        nonce: i * 100 + s,
      });
      session += spin.totalWin;
      carried = spin.multipliers.freeSpinTotal;
      if (spin.totalWin > 0) winning += 1;
      const applied = spin.multipliers.applied;
      if (applied > 1) {
        appliedSum += applied;
        appliedN += 1;
        if (spin.multipliers.collected > applied) clipped += 1;
      }
    }
    returns.push(session);
    win += session;
  }
  returns.sort((a, b) => a - b);
  const mid = returns[Math.floor(returns.length / 2)];
  return {
    avgReturnX: Math.round((win / rounds) * 100) / 100,
    medianX: Math.round(mid * 100) / 100,
    costX: dice.BUY_COST_MULT,
    winRate: Math.round((winning / spins) * 10000) / 10000,
    meanApplied: appliedN ? Math.round((appliedSum / appliedN) * 100) / 100 : 0,
    clipRate: appliedN ? Math.round((clipped / appliedN) * 1000) / 1000 : 0,
    cap: dice.BONUS_BANK_CAP,
    payScale: dice.FREESPIN_PAY_SCALE,
  };
}

function poseidonBuy(rounds) {
  let win = 0;
  let appliedSum = 0;
  let appliedN = 0;
  let clipped = 0;
  let winning = 0;
  const spins = rounds * poseidon.FREE_SPINS_BOUGHT;
  for (let i = 0; i < rounds; i += 1) {
    let carried = 0;
    for (let s = 0; s < poseidon.FREE_SPINS_BOUGHT; s += 1) {
      const spin = resolveSpin({ bonusMode: true });
      const r = poseidon.resolvePayoutMultiplier({
        baseWin: spin.baseWin,
        plaqueSum: spin.multiplierSum,
        carried,
        isFreeSpin: true,
        bankCap: poseidon.BONUS_BANK_CAP,
      });
      carried = r.nextCarried;
      const total = spin.baseWin * r.applied;
      win += total;
      if (total > 0) winning += 1;
      if (r.applied > 1) {
        appliedSum += r.applied;
        appliedN += 1;
        if (spin.multiplierSum > r.applied) clipped += 1;
      }
    }
  }
  return {
    avgReturnX: Math.round((win / rounds) * 100) / 100,
    costX: 25,
    winRate: Math.round((winning / spins) * 10000) / 10000,
    meanApplied: appliedN ? Math.round((appliedSum / appliedN) * 100) / 100 : 0,
    clipRate: appliedN ? Math.round((clipped / appliedN) * 1000) / 1000 : 0,
    cap: poseidon.BONUS_BANK_CAP,
    cluster: poseidon.BONUS_CLUSTER_SCALE,
  };
}

async function main() {
  const pb = poseidonSample(2000, false);
  const zb = zeusSample(2000, false);
  const pBuy = poseidonSample(800, true);
  const zBuy = zeusSample(800, true);
  const zSession = zeusBuy(600);
  const pSession = poseidonBuy(200);
  const baseRtp = zeusBaseRtp(4000);
  await post("C", "tool/_debug_winrate.js", "multiplier method versus poseidon", {
    poseidonBase: pb,
    zeusBase: zb,
    poseidonBonus: pBuy,
    zeusBonus: zBuy,
    zeusBuy: zSession,
    poseidonBuy: pSession,
    zeusBankCap: dice.BONUS_BANK_CAP,
    poseidonBankCap: poseidon.BONUS_BANK_CAP,
    baseRtp,
    zeusPayScale: dice.FREESPIN_PAY_SCALE,
    basePayScale: dice.BASE_PAY_SCALE,
    poseidonCluster: poseidon.BONUS_CLUSTER_SCALE,
  });
  console.log(JSON.stringify({ baseRtp, zSession, pSession, zBuy, pBuy }));
}

main();
