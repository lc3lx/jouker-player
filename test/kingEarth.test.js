/**
 * King Earth (Zeus) slot — engine + free-spins state unit tests.
 * Run: node --test test/kingEarth.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const DiceEngine = require("../games/dice/DiceEngine");
const roundState = require("../games/dice/kingArthRoundState");

const COLS = 6;
const ROWS = 5;

/** Build a column-major grid[col][row] from a filler function. */
function makeGrid(fill) {
  const g = [];
  for (let c = 0; c < COLS; c++) {
    g[c] = [];
    for (let r = 0; r < ROWS; r++) g[c][r] = fill(c, r);
  }
  return g;
}

test("paytable bands are per-symbol and match the screenshots", () => {
  // Crown (idx 5): 8, 20, 40 for 8-9 / 10-11 / 12+
  assert.equal(DiceEngine.symbolMultiplier(5, 7), 0);
  assert.equal(DiceEngine.symbolMultiplier(5, 8), 8);
  assert.equal(DiceEngine.symbolMultiplier(5, 9), 8);
  assert.equal(DiceEngine.symbolMultiplier(5, 10), 20);
  assert.equal(DiceEngine.symbolMultiplier(5, 11), 20);
  assert.equal(DiceEngine.symbolMultiplier(5, 12), 40);
  assert.equal(DiceEngine.symbolMultiplier(5, 30), 40);
  // Sapphire (idx 4, lowest): 0.2, 0.6, 1.6
  assert.equal(DiceEngine.symbolMultiplier(4, 8), 0.2);
  assert.equal(DiceEngine.symbolMultiplier(4, 10), 0.6);
  assert.equal(DiceEngine.symbolMultiplier(4, 12), 1.6);
  // Chalice (idx 8) outranks Ruby (idx 0) at the top band (9.6 vs 8)
  assert.ok(DiceEngine.symbolMultiplier(8, 12) > DiceEngine.symbolMultiplier(0, 12));
});

test("scatter pays 2.4 / 4 / 80 at 4 / 5 / 6+ (pay anywhere)", () => {
  const SCATTER = DiceEngine.SCATTER; // 9
  // Grid with exactly `n` scatters, the rest split so no regular symbol reaches 8.
  const scatterGrid = (n) => {
    const cells = [];
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) cells.push([c, r]);
    const g = makeGrid((c, r) => (c + r * 2) % 5); // 5 gem symbols, 6 each → none ≥ 8
    for (let i = 0; i < n; i++) {
      const [c, r] = cells[i];
      g[c][r] = SCATTER;
    }
    return g;
  };
  assert.equal(DiceEngine.calculateWins(scatterGrid(3), 1).totalWin, 0); // 3 = no pay
  assert.equal(DiceEngine.calculateWins(scatterGrid(4), 1).totalWin, 2.4);
  assert.equal(DiceEngine.calculateWins(scatterGrid(5), 1).totalWin, 4);
  assert.equal(DiceEngine.calculateWins(scatterGrid(6), 1).totalWin, 80);
});

test("config constants match the reference game", () => {
  assert.equal(DiceEngine.FREE_SPINS_AWARD, 15);
  assert.equal(DiceEngine.RETRIGGER_AWARD, 5);
  assert.equal(DiceEngine.RETRIGGER_MIN_SCATTER, 3);
  assert.equal(DiceEngine.BUY_COST_MULT, 100);
  assert.equal(DiceEngine.MAX_WIN_MULTIPLIER, 4000);
  assert.equal(DiceEngine.BET_MIN, 0.2);
  assert.equal(DiceEngine.BET_MAX, 300);
  assert.equal(DiceEngine.MULTIPLIER_VALUES.length, 15);
  assert.equal(DiceEngine.MULTIPLIER_VALUES[0], 2);
  assert.equal(DiceEngine.MULTIPLIER_VALUES.at(-1), 500);
});

test("spin is deterministic for a fixed (serverSeed, clientSeed, nonce)", () => {
  const opts = { serverSeed: "srv-seed-abc", clientSeed: "cli-seed", nonce: "42", volatility: "medium" };
  const a = DiceEngine.spin(1, opts);
  const b = DiceEngine.spin(1, opts);
  assert.deepEqual(a.grid, b.grid);
  assert.equal(a.totalWin, b.totalWin);
  assert.deepEqual(a.finalGrid, b.finalGrid);
});

test("no spin ever pays more than the 4000× cap", () => {
  const cap = DiceEngine.MAX_WIN_MULTIPLIER;
  for (let i = 0; i < 20000; i++) {
    const out = DiceEngine.spin(1, {
      serverSeed: `cap-${i}`,
      clientSeed: "cli",
      nonce: `${i + 1}`,
      volatility: "high",
      isFreeSpin: i % 3 === 0,
      freeSpinMultiplier: i % 3 === 0 ? 50 : 0,
    });
    assert.ok(out.totalWin <= cap * out.stake + 1e-6, `spin ${i} exceeded cap: ${out.totalWin}`);
  }
});

test("free-spins state: initial 15, retrigger +5, cumulative 4000× cap", async () => {
  const uid = `test-user-${Date.now()}`;
  const tid = "king-earth-test";
  try {
    // Initial award on 4+ scatters seeds the round with the triggering win.
    const s0 = await roundState.awardFreeSpins(uid, tid, 4, 1, false, {
      roundCap: 4000,
      initialWin: 10,
    });
    assert.equal(s0.remaining, 15);
    assert.equal(s0.roundWon, 10);
    assert.equal(s0.roundCap, 4000);

    // Fewer than 4 scatters never opens a session for a fresh user.
    const uid2 = `${uid}-b`;
    const none = await roundState.awardFreeSpins(uid2, tid, 3, 1, false, { roundCap: 4000 });
    assert.equal(none, null);

    // Retrigger adds 5.
    const s1 = await roundState.addRetriggerSpins(uid, tid, DiceEngine.RETRIGGER_AWARD);
    assert.equal(s1.remaining, 20);

    // recordRoundWin clamps to the remaining allowance and flags the cap.
    const capped = await roundState.recordRoundWin(uid, tid, 5000); // allowance = 4000 - 10
    assert.equal(capped.payout, 3990);
    assert.equal(capped.capReached, true);
  } finally {
    await roundState.deleteFreeSpinSession(uid, tid);
  }
});

test("seeded RTP smoke — base mode lands in a sane band", () => {
  const MAX_BANKED = 50;
  const bet = 1;
  const rounds = 60000;
  let totalBet = 0;
  let totalWin = 0;

  const runFreeSpins = (seedBase, roundCapLeft) => {
    let remaining = DiceEngine.FREE_SPINS_AWARD;
    let totalMultiplier = 0;
    let capLeft = roundCapLeft;
    let win = 0;
    let i = 0;
    while (remaining > 0 && capLeft > 0) {
      const o = DiceEngine.spin(bet, {
        serverSeed: `${seedBase}-fs-${i}`,
        clientSeed: "smoke",
        nonce: `${i + 1}`,
        isFreeSpin: true,
        freeSpinMultiplier: totalMultiplier,
        volatility: "medium",
      });
      let pay = o.totalWin;
      if (pay > capLeft) pay = capLeft;
      win += pay;
      capLeft -= pay;
      totalMultiplier = o.multipliers.freeSpinTotal;
      if (o.scatterCount >= DiceEngine.RETRIGGER_MIN_SCATTER) {
        remaining = Math.min(remaining + DiceEngine.RETRIGGER_AWARD, MAX_BANKED);
      }
      remaining -= 1;
      i += 1;
    }
    return win;
  };

  for (let i = 0; i < rounds; i++) {
    const stake = bet;
    const cap = DiceEngine.MAX_WIN_MULTIPLIER * stake;
    const o = DiceEngine.spin(bet, {
      serverSeed: `smoke-${i}`,
      clientSeed: "smoke",
      nonce: `${i + 1}`,
      volatility: "medium",
    });
    let roundWin = Math.min(o.totalWin, cap);
    if (o.scatterCount >= 4) roundWin += runFreeSpins(`smoke-${i}`, cap - roundWin);
    totalBet += stake;
    totalWin += roundWin;
  }

  const rtp = totalWin / totalBet;
  // Wide band: 60k rounds under-samples the rare near-cap wins, so allow slack.
  assert.ok(rtp > 0.85 && rtp < 1.08, `RTP out of sane band: ${(rtp * 100).toFixed(2)}%`);
});
