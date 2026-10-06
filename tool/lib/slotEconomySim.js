"use strict";

/**
 * Slot economy simulator — drives the PRODUCTION engines through the
 * PRODUCTION settlement modules (never a re-implementation), one per-spin
 * seeded crypto RNG stream per spin exactly like the live services, spread
 * over worker threads.
 *
 *   simulate({ game, profile, kind: "base", count })            paid spins
 *   simulate({ game, profile, kind: "session", mode, count })   bonus rounds
 *                                         mode = natural | bonus | super
 *
 * Besides the raw Monte-Carlo totals, base runs return the decomposition the
 * calibrator solves against: the plaque-free part of the cluster pay (A) and,
 * per plaque face, the capped pay that face would produce (g[v]). Because the
 * plaque face is drawn independently of the board, base RTP for ANY face table
 * with the same visibility is A + Σ q_v·g[v] + p_nat·EV_nat + p_jp·EV_jp —
 * which makes calibration precise without re-simulating each candidate.
 */

const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

const BACKEND = path.join(__dirname, "../..");
const JACKPOT_EV_X = (100 + 500 + 1000) / 3; // first triple of a 3×3 shuffled board
const ZEUS_BET = 10000;
const RETURN_BUCKETS = [0, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, Infinity];

function req(rel) {
  return require(path.join(BACKEND, rel));
}

// --- game adapters (production code only) -----------------------------------------

function adapter(game) {
  if (game === "poseidon" || game === "zenobia") {
    const engine = req(`games/${game}/spinEngine`);
    const { settleSpin } = req(`games/${game}/settlement`);
    const version = game === "poseidon" ? 4 : 3;
    return {
      spin(profile, mode, rng) {
        const s = engine.resolveSpin({
          economyVersion: version, profile, rng,
          bonusMode: mode !== "base", superBonus: mode === "super",
        });
        return {
          raw: s,
          W: s.baseWin,
          faces: s.multipliers.map((m) => m.value),
          jackpots: s.jackpotCount,
          scatters: s.scatterCount,
        };
      },
      /** session: null (paid) or { bonusMultiplier, roundWonX, freeSpinsRemaining } */
      settle(profile, facts, session) {
        const r = settleSpin({ spin: facts.raw, economyVersion: version, rules: profile.rules, session, canTrigger: true });
        const remainingAfter = session == null || r.capReached
          ? 0
          : session.freeSpinsRemaining + (r.award?.type === "retrigger" ? r.award.spins : 0) - 1;
        return { winX: r.winX, applied: r.applied, nextCarried: r.nextCarried, capReached: r.capReached, award: r.award, remainingAfter };
      },
    };
  }
  if (game === "zeus") {
    const engine = req("games/dice/DiceEngine");
    const { settleSpin } = req("games/dice/kingArthSettlement");
    return {
      spin(profile, mode, rng, carried = 0) {
        const o = engine.spin(ZEUS_BET, {
          economyVersion: 5, profile, rng,
          isFreeSpin: mode !== "base", superBonus: mode === "super", freeSpinMultiplier: carried,
        });
        return {
          raw: o,
          W: o.baseWin / ZEUS_BET,
          faces: o.multipliers.collected > 0 ? [o.multipliers.collected] : [],
          jackpots: o.jackpotSymbolCount,
          scatters: o.scatterCount,
        };
      },
      settle(profile, facts, session) {
        // kingArthSettlement works on the handler's session shape, in coins.
        const previous = session == null ? null : {
          remaining: session.freeSpinsRemaining,
          totalMultiplier: session.bonusMultiplier,
          roundCap: profile.rules.maxWinX * ZEUS_BET,
          roundWon: Math.round(session.roundWonX * ZEUS_BET),
          superBonus: !!session.superBonus,
          lockedBaseBet: ZEUS_BET,
        };
        const staged = settleSpin(facts.raw, previous, ZEUS_BET, ZEUS_BET);
        const award = staged.awarded > 0
          ? { type: session == null ? "create" : "retrigger", spins: staged.awarded }
          : null;
        return {
          winX: staged.payout / ZEUS_BET,
          applied: facts.raw.multipliers.applied,
          nextCarried: facts.raw.multipliers.freeSpinTotal,
          capReached: staged.capReached && session != null,
          award,
          remainingAfter: session == null ? 0 : (staged.next ? staged.next.remaining : 0),
        };
      },
    };
  }
  throw new Error(`unknown game ${game}`);
}

// --- one bonus round (mirrors the services' free-spin loop) ----------------------

function playSession(a, profile, mode, seed, initialWinX = 0) {
  const bought = mode !== "natural";
  const spinMode = mode === "super" ? "super" : "bonus";
  const session = {
    freeSpinsRemaining: bought ? profile.rules.freeSpinsBought : profile.rules.freeSpinsNatural,
    bonusMultiplier: 0,
    roundWonX: initialWinX,
    superBonus: mode === "super",
  };
  const { createOperationRng } = req("games/utils/operationRng");
  let wonX = 0;
  let jackpotX = 0;
  let spins = 0;
  let retriggers = 0;
  let capped = false;
  let jackpots = 0;
  while (session.freeSpinsRemaining > 0) {
    if (++spins > 10000) throw new Error("bonus round did not terminate");
    const rng = createOperationRng(`${seed}:${spins}`);
    const facts = a.spin(profile, spinMode, rng, session.bonusMultiplier);
    const r = a.settle(profile, facts, session);
    session.bonusMultiplier = r.nextCarried;
    session.roundWonX += r.winX;
    wonX += r.winX;
    if (facts.jackpots >= 3) {
      jackpots += 1;
      jackpotX += JACKPOT_EV_X;
    }
    if (r.capReached) capped = true;
    if (r.award?.type === "retrigger") retriggers += 1;
    session.freeSpinsRemaining = r.remainingAfter;
  }
  return { wonX, jackpotX, spins, retriggers, capped, jackpots };
}

// --- chunk runners (executed inside workers) --------------------------------------

function emptyBuckets() {
  return RETURN_BUCKETS.slice(0, -1).map(() => 0);
}

function bucketOf(x) {
  for (let i = 0; i < RETURN_BUCKETS.length - 1; i += 1) {
    if (x >= RETURN_BUCKETS[i] && x < RETURN_BUCKETS[i + 1]) return i;
  }
  return RETURN_BUCKETS.length - 2;
}

function runBaseChunk({ game, profile, from, to, seed }) {
  const a = adapter(game);
  const { createOperationRng } = req("games/utils/operationRng");
  const faces = profile.params.plaques.values;
  const cap = profile.rules.maxWinX;
  const out = {
    n: 0, hits: 0, hitsAtLeastBet: 0, sumSpin: 0, sumTotal: 0, sumTotalSq: 0,
    sumSessions: 0, sumJackpot: 0, natTriggers: 0, jpTriggers: 0, plaqueVisible: 0, plaqueApplied: 0,
    cappedSpins: 0, maxTotal: 0, A: 0, g: faces.map(() => 0), plaqueWinWeight: 0, sumWN: 0,
    buckets: emptyBuckets(), near: 0,
  };
  for (let i = from; i < to; i += 1) {
    const rng = createOperationRng(`${seed}:b:${i}`);
    const facts = a.spin(profile, "base", rng);
    const r = a.settle(profile, facts, null);
    out.n += 1;
    let total = r.winX;
    out.sumSpin += r.winX;
    if (r.winX > 0) out.hits += 1;
    if (r.winX >= 1) out.hitsAtLeastBet += 1;
    if (facts.W * r.applied > cap) out.cappedSpins += 1;
    if (facts.faces.length > 0) {
      out.plaqueVisible += 1;
      if (r.applied > 1) out.plaqueApplied += 1;
    }
    // Decomposition (independent plaque faces).
    if (facts.faces.length === 0) out.A += Math.min(facts.W, cap);
    else if (facts.W > 0) {
      for (let k = 0; k < faces.length; k += 1) out.g[k] += Math.min(facts.W * faces[k], cap);
      out.sumWN += facts.W * facts.faces.length;
    }
    if (facts.jackpots >= 3) {
      out.jpTriggers += 1;
      out.sumJackpot += JACKPOT_EV_X;
      total += JACKPOT_EV_X;
    }
    if (facts.scatters === profile.rules.triggerNaturalMin - 1) out.near += 1;
    if (r.award?.type === "create") {
      out.natTriggers += 1;
      const s = playSession(a, profile, "natural", `${seed}:n:${i}`, r.winX);
      out.sumSessions += s.wonX + s.jackpotX;
      out.sumJackpot += s.jackpotX;
      total += s.wonX + s.jackpotX;
    }
    out.sumTotal += total;
    out.sumTotalSq += total * total;
    out.maxTotal = Math.max(out.maxTotal, total);
    out.buckets[bucketOf(total)] += 1;
  }
  return out;
}

function runSessionChunk({ game, profile, mode, from, to, seed }) {
  const a = adapter(game);
  const out = {
    n: 0, sum: 0, sumSq: 0, sumJackpot: 0, spins: 0, retriggers: 0, capped: 0, jackpots: 0, max: 0,
    buckets: emptyBuckets(),
  };
  for (let i = from; i < to; i += 1) {
    const s = playSession(a, profile, mode, `${seed}:s:${i}`);
    const total = s.wonX + s.jackpotX;
    out.n += 1;
    out.sum += total;
    out.sumSq += total * total;
    out.sumJackpot += s.jackpotX;
    out.spins += s.spins;
    out.retriggers += s.retriggers;
    out.capped += s.capped ? 1 : 0;
    out.jackpots += s.jackpots;
    out.max = Math.max(out.max, total);
    out.buckets[bucketOf(total)] += 1;
  }
  return out;
}

function runChunk(task) {
  return task.kind === "base" ? runBaseChunk(task) : runSessionChunk(task);
}

// --- merging + summaries --------------------------------------------------------------

function merge(parts) {
  const total = structuredClone(parts[0]);
  for (const part of parts.slice(1)) {
    for (const [key, value] of Object.entries(part)) {
      if (key === "maxTotal" || key === "max") total[key] = Math.max(total[key], value);
      else if (Array.isArray(value)) value.forEach((v, i) => { total[key][i] += v; });
      else total[key] += value;
    }
  }
  return total;
}

function percentileFromBuckets(buckets, n, p) {
  let seen = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    seen += buckets[i];
    if (seen / n >= p) return RETURN_BUCKETS[i + 1];
  }
  return Infinity;
}

function summarizeBase(profile, s) {
  const n = s.n;
  const mean = s.sumTotal / n;
  const sd = Math.sqrt(Math.max(0, s.sumTotalSq / n - mean * mean));
  return {
    spins: n,
    rtp: mean,
    ci95: 1.96 * sd / Math.sqrt(n),
    sdPerSpin: sd,
    parts: { spins: s.sumSpin / n, freeSpins: (s.sumSessions - (s.sumJackpot - s.jpTriggers * JACKPOT_EV_X)) / n, jackpot: s.sumJackpot / n },
    hitRate: s.hits / n,
    winAtLeastBetRate: s.hitsAtLeastBet / n,
    freeSpinsOneIn: s.natTriggers ? n / s.natTriggers : null,
    jackpotOneIn: s.jpTriggers ? n / s.jpTriggers : null,
    plaqueVisibleRate: s.plaqueVisible / n,
    plaqueAppliedRate: s.plaqueApplied / n,
    nearMissRate: s.near / n,
    cappedSpins: s.cappedSpins,
    maxWinX: s.maxTotal,
    decomposition: { A: s.A / n, g: s.g.map((x) => x / n), wn: s.sumWN / n },
    returnDistribution: Object.fromEntries(s.buckets.map((c, i) => [`${RETURN_BUCKETS[i]}-${RETURN_BUCKETS[i + 1]}`, c / n])),
  };
}

function summarizeSessions(s) {
  const n = s.n;
  const mean = s.sum / n;
  const sd = Math.sqrt(Math.max(0, s.sumSq / n - mean * mean));
  return {
    sessions: n,
    evX: mean,
    ci95X: 1.96 * sd / Math.sqrt(n),
    sdX: sd,
    jackpotEvX: s.sumJackpot / n,
    avgSpins: s.spins / n,
    retriggersPerRound: s.retriggers / n,
    cappedRounds: s.capped,
    maxX: s.max,
    medianX: percentileFromBuckets(s.buckets, n, 0.5),
    p90X: percentileFromBuckets(s.buckets, n, 0.9),
    returnDistribution: Object.fromEntries(s.buckets.map((c, i) => [`${RETURN_BUCKETS[i]}-${RETURN_BUCKETS[i + 1]}`, c / n])),
  };
}

// --- parallel driver ------------------------------------------------------------------

function workerCount(count) {
  const cores = Math.max(1, (os.availableParallelism?.() || os.cpus().length) - 1);
  return Math.max(1, Math.min(cores, Math.ceil(count / 5000)));
}

/**
 * @param {object} args
 * @param {"poseidon"|"zeus"|"zenobia"} args.game
 * @param {object} args.profile  full profile (params + rules)
 * @param {"base"|"session"} args.kind
 * @param {"natural"|"bonus"|"super"} [args.mode]
 * @param {number} args.count    paid spins (base) or rounds (session)
 * @param {string} [args.seed]
 */
async function simulate({ game, profile, kind, mode = "bonus", count, seed = "sim", workers }) {
  const w = workers || workerCount(count);
  const per = Math.ceil(count / w);
  const tasks = [];
  for (let k = 0; k < w; k += 1) {
    const from = k * per;
    const to = Math.min(count, from + per);
    if (from < to) tasks.push({ game, profile, kind, mode, from, to, seed });
  }
  const parts = w === 1
    ? [runChunk(tasks[0])]
    : await Promise.all(tasks.map((task) => new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: task });
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
    })));
  const merged = merge(parts);
  return kind === "base" ? summarizeBase(profile, merged) : summarizeSessions(merged);
}

if (!isMainThread && workerData) {
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  parentPort.postMessage(runChunk(workerData));
}

module.exports = { simulate, runChunk, playSession, adapter, JACKPOT_EV_X };
