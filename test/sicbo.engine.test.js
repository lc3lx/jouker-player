const test = require("node:test");
const assert = require("node:assert/strict");

const {
  rollDice,
  evaluateBet,
  settleBets,
  summarize,
  isTriple,
  diceTotal,
} = require("../games/sicbo/sicboEngine");
const {
  createRoundCommitment,
  verifyRound,
  hashServerSeed,
} = require("../games/sicbo/sicboSeed");
const { BET_CATALOG, oddsFor } = require("../games/sicbo/sicboConstants");

// ─── Dice generation determinism + provably fair ─────────────────────────────

test("rollDice is deterministic for the same seeds", () => {
  const a = rollDice("server-seed-abc", "client-1", "42");
  const b = rollDice("server-seed-abc", "client-1", "42");
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  for (const d of a) assert.ok(d >= 1 && d <= 6, `die ${d} in range`);
});

test("rollDice changes with nonce", () => {
  const a = rollDice("server-seed-abc", "client-1", "1");
  const b = rollDice("server-seed-abc", "client-1", "2");
  assert.notDeepEqual(a, b);
});

test("provably-fair commitment verifies and detects tampering", () => {
  const c = createRoundCommitment("round-100");
  assert.equal(hashServerSeed(c.serverSeed), c.serverSeedHash);
  const dice = rollDice(c.serverSeed, c.clientSeed, c.nonce);
  const ok = verifyRound({ ...c, dice });
  assert.equal(ok.valid, true);
  assert.equal(ok.hashOk, true);
  assert.equal(ok.diceOk, true);

  // Tampered dice must fail.
  const bad = verifyRound({ ...c, dice: [1, 1, 1] });
  assert.equal(bad.valid, false);

  // Tampered hash must fail.
  const badHash = verifyRound({ ...c, serverSeedHash: "deadbeef", dice });
  assert.equal(badHash.valid, false);
});

test("dice distribution is roughly uniform over many rolls", () => {
  const counts = new Array(7).fill(0);
  const N = 60000;
  for (let i = 0; i < N; i += 1) {
    const dice = rollDice("dist-seed", "c", String(i));
    for (const d of dice) counts[d] += 1;
  }
  const total = N * 3;
  for (let f = 1; f <= 6; f += 1) {
    const p = counts[f] / total;
    assert.ok(Math.abs(p - 1 / 6) < 0.01, `face ${f} freq ${p.toFixed(4)} ~ 0.1667`);
  }
});

// ─── Big / Small / Odd / Even + triple rule ──────────────────────────────────

test("big wins on 11-17 non-triple, loses on triple", () => {
  assert.equal(evaluateBet("big", [6, 5, 3]).won, true); // 14
  assert.equal(evaluateBet("big", [1, 2, 3]).won, false); // 6 small
  // Triple 6 = total 18 but big LOSES on any triple.
  assert.equal(evaluateBet("big", [6, 6, 6]).won, false);
});

test("small wins on 4-10 non-triple, loses on triple", () => {
  assert.equal(evaluateBet("small", [1, 2, 3]).won, true); // 6
  assert.equal(evaluateBet("small", [6, 5, 3]).won, false); // 14 big
  // Triple 2 = total 6 (small range) but small LOSES on triple.
  assert.equal(evaluateBet("small", [2, 2, 2]).won, false);
});

test("odd/even lose on any triple", () => {
  assert.equal(evaluateBet("odd", [1, 2, 4]).won, true); // 7 odd
  assert.equal(evaluateBet("even", [2, 2, 4]).won, true); // 8 even
  // Triple 3 = total 9 (odd) but loses on triple.
  assert.equal(evaluateBet("odd", [3, 3, 3]).won, false);
  // Triple 2 = total 6 (even) but loses on triple.
  assert.equal(evaluateBet("even", [2, 2, 2]).won, false);
});

test("big/small pay 1:1 net", () => {
  assert.equal(evaluateBet("big", [6, 5, 3]).multiplier, 1);
  assert.equal(evaluateBet("small", [1, 2, 3]).multiplier, 1);
});

// ─── Single die 1:1 / 2:1 / 3:1 ──────────────────────────────────────────────

test("single die pays per matching die", () => {
  assert.deepEqual(evaluateBet("single_5", [5, 2, 3]), { won: true, multiplier: 1 });
  assert.deepEqual(evaluateBet("single_5", [5, 5, 3]), { won: true, multiplier: 2 });
  assert.deepEqual(evaluateBet("single_5", [5, 5, 5]), { won: true, multiplier: 3 });
  assert.deepEqual(evaluateBet("single_5", [1, 2, 3]), { won: false, multiplier: 0 });
});

// ─── Totals, doubles, triples, any-triple, combos ────────────────────────────

test("total bets pay standard odds", () => {
  assert.deepEqual(evaluateBet("total_4", [1, 1, 2]), { won: true, multiplier: 60 });
  assert.deepEqual(evaluateBet("total_17", [6, 6, 5]), { won: true, multiplier: 60 });
  assert.deepEqual(evaluateBet("total_10", [5, 3, 2]), { won: true, multiplier: 6 });
  assert.equal(evaluateBet("total_10", [1, 1, 1]).won, false);
});

test("specific double needs >=2 of the face", () => {
  assert.equal(evaluateBet("double_4", [4, 4, 1]).won, true);
  assert.equal(evaluateBet("double_4", [4, 4, 4]).won, true);
  assert.equal(evaluateBet("double_4", [4, 1, 2]).won, false);
  assert.equal(evaluateBet("double_4", [4, 4, 1]).multiplier, 10);
});

test("specific triple needs exact triple, pays 180", () => {
  assert.deepEqual(evaluateBet("triple_3", [3, 3, 3]), { won: true, multiplier: 180 });
  assert.equal(evaluateBet("triple_3", [3, 3, 1]).won, false);
  assert.equal(evaluateBet("triple_3", [6, 6, 6]).won, false);
});

test("any_triple pays 30 on any triple", () => {
  assert.deepEqual(evaluateBet("any_triple", [2, 2, 2]), { won: true, multiplier: 30 });
  assert.equal(evaluateBet("any_triple", [2, 2, 1]).won, false);
});

test("combo needs both faces present, pays 5", () => {
  assert.deepEqual(evaluateBet("combo_25", [2, 5, 1]), { won: true, multiplier: 5 });
  assert.equal(evaluateBet("combo_25", [2, 2, 1]).won, false);
  assert.equal(evaluateBet("combo_25", [2, 5, 5]).won, true);
});

test("unknown bet type never wins", () => {
  assert.deepEqual(evaluateBet("garbage", [1, 2, 3]), { won: false, multiplier: 0 });
  assert.deepEqual(evaluateBet("total_99", [1, 2, 3]), { won: false, multiplier: 0 });
});

// ─── settleBets ──────────────────────────────────────────────────────────────

test("settleBets returns stake+winnings for winners and 0 for losers", () => {
  const dice = [6, 5, 3]; // total 14, big, even
  const bets = [
    { betType: "big", amount: 10000, userId: "u1" },
    { betType: "small", amount: 20000, userId: "u2" },
    { betType: "single_6", amount: 10000, userId: "u3" },
  ];
  const { results, totalStake, totalPayout, houseProfit } = settleBets(bets, dice);
  assert.equal(totalStake, 40000);
  // big: 10000 stake + 10000 net = 20000; small: 0; single_6 (one match): 10000+10000=20000
  assert.equal(results[0].payout, 20000);
  assert.equal(results[1].payout, 0);
  assert.equal(results[2].payout, 20000);
  assert.equal(totalPayout, 40000);
  assert.equal(houseProfit, 0);
  assert.equal(results[0].status, "won");
  assert.equal(results[1].status, "lost");
});

test("summarize marks triples", () => {
  const s = summarize([4, 4, 4]);
  assert.equal(s.isTriple, true);
  assert.equal(s.bigSmall, "triple");
  assert.equal(s.oddEven, "triple");
  assert.equal(s.total, 12);
});

// ─── Catalog integrity ───────────────────────────────────────────────────────

test("bet catalog has the expected number of bet types", () => {
  // 4 (big/small/odd/even) + 14 totals + 6 doubles + 6 triples + 1 any + 15 combos + 6 singles = 52
  assert.equal(BET_CATALOG.size, 52);
  assert.equal(oddsFor("triple_1"), 180);
  assert.equal(oddsFor("nope"), 0);
});

// ─── RTP simulation (house edge is positive and within a sane band) ──────────

const { simulate } = require("../games/sicbo/sicboRtp");

test("RTP simulation keeps every bet type in a house-favourable band", () => {
  // Standard Sic Bo house edges range ~2.8% (big/small) to ~30% (specific triple).
  const cases = [
    { betType: "big", maxEdge: 0.05 },
    { betType: "small", maxEdge: 0.05 },
    { betType: "odd", maxEdge: 0.05 },
    { betType: "single_3", maxEdge: 0.10 },
    { betType: "any_triple", maxEdge: 0.20 },
    { betType: "total_10", maxEdge: 0.16 },
  ];
  for (const c of cases) {
    const { rtp, houseEdge } = simulate(c.betType, 300000);
    assert.ok(rtp > 0.5 && rtp <= 1.05, `${c.betType} rtp ${rtp.toFixed(4)} sane`);
    assert.ok(houseEdge >= -0.02, `${c.betType} edge ${houseEdge.toFixed(4)} favours house`);
    assert.ok(houseEdge <= c.maxEdge + 0.03, `${c.betType} edge ${houseEdge.toFixed(4)} <= ~${c.maxEdge}`);
  }
});

test("specific triple has a large house edge (~30%) but pays 180x on hit", () => {
  const { rtp } = simulate("triple_3", 600000);
  // Probability 1/216, pays 180:1 net → RTP ≈ 181/216 ≈ 0.838.
  assert.ok(rtp > 0.6 && rtp < 1.0, `triple rtp ${rtp.toFixed(4)}`);
});
