/**
 * The order a player sees agents in.
 *
 * It used to be `sort((a, b) => Number(b.online) - Number(a.online))` and
 * nothing else: past the online/offline split the order was whatever Mongo
 * returned, so a brand new agent could sit above one with a thousand completed
 * deposits and a five-star record.
 */
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MIN_RATINGS_TO_RANK,
  rankAgents,
  foldResponseTime,
} = require("../services/agentRanking");

/** An agent with everything neutral, so each test varies one thing. */
function agent(id, over = {}) {
  return {
    agentProfileId: id,
    online: false,
    rating: 5,
    ratingCount: 0,
    totalDeposits: 0,
    avgResponseMinutes: 0,
    ...over,
  };
}

const ids = (rows) => rows.map((r) => r.agentProfileId);

test("an agent who can answer now comes first", () => {
  const out = rankAgents([
    agent("offline_star", {
      rating: 5,
      ratingCount: 500,
      totalDeposits: 9999,
    }),
    agent("online_nobody", { online: true }),
  ]);
  assert.deepEqual(ids(out), ["online_nobody", "offline_star"]);
});

test("among agents who can answer, the better rated wins", () => {
  const out = rankAgents([
    agent("three_star", { online: true, rating: 3, ratingCount: 40 }),
    agent("five_star", { online: true, rating: 5, ratingCount: 40 }),
  ]);
  assert.deepEqual(ids(out), ["five_star", "three_star"]);
});

test("one glowing review does not outrank a long record", () => {
  const out = rankAgents([
    agent("one_review", {
      online: true,
      rating: 5,
      ratingCount: 1,
      totalDeposits: 0,
    }),
    agent("proven", {
      online: true,
      rating: 4.6,
      ratingCount: 200,
      totalDeposits: 800,
    }),
  ]);
  assert.deepEqual(
    ids(out),
    ["proven", "one_review"],
    `a rating counts only past ${MIN_RATINGS_TO_RANK} reviews`
  );
});

test("unrated agents fall back to the record they do have", () => {
  const out = rankAgents([
    agent("new", { online: true, totalDeposits: 2 }),
    agent("busy", { online: true, totalDeposits: 400 }),
  ]);
  assert.deepEqual(ids(out), ["busy", "new"]);
});

test("a faster replier breaks an otherwise exact tie", () => {
  const out = rankAgents([
    agent("slow", { online: true, totalDeposits: 10, avgResponseMinutes: 45 }),
    agent("fast", { online: true, totalDeposits: 10, avgResponseMinutes: 3 }),
  ]);
  assert.deepEqual(ids(out), ["fast", "slow"]);
});

test("never having been timed does not count as instant", () => {
  const out = rankAgents([
    agent("untimed", { online: true, totalDeposits: 10, avgResponseMinutes: 0 }),
    agent("timed", { online: true, totalDeposits: 10, avgResponseMinutes: 30 }),
  ]);
  assert.deepEqual(
    ids(out),
    ["timed", "untimed"],
    "0 means unmeasured, not a zero-minute reply"
  );
});

test("identical agents keep a stable order", () => {
  const rows = [agent("bbb", { online: true }), agent("aaa", { online: true })];
  assert.deepEqual(ids(rankAgents(rows)), ["aaa", "bbb"]);
  assert.deepEqual(
    ids(rankAgents([...rows].reverse())),
    ["aaa", "bbb"],
    "the list must not reshuffle between reads"
  );
});

test("the input list is not mutated", () => {
  const rows = [agent("b", { online: false }), agent("a", { online: true })];
  const before = ids(rows);
  rankAgents(rows);
  assert.deepEqual(ids(rows), before);
});

test("junk fields do not throw or win", () => {
  const out = rankAgents([
    agent("good", { online: true, rating: 5, ratingCount: 10 }),
    { agentProfileId: "junk", rating: "abc", ratingCount: null, online: "yes" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(ids(out)[0], "good");
  assert.deepEqual(rankAgents(null), []);
  assert.deepEqual(rankAgents(undefined), []);
});

// ── response time ───────────────────────────────────────────────────────────

test("the first measurement is adopted, not halved against zero", () => {
  assert.equal(
    foldResponseTime(0, 10),
    10,
    "averaging against an unmeasured 0 would report 5 minutes"
  );
});

test("later measurements move the average without erasing history", () => {
  const next = foldResponseTime(10, 20);
  assert.ok(next > 10 && next < 20, `expected between 10 and 20, got ${next}`);
});

test("an agent who gets slow is eventually reported as slow", () => {
  let avg = 5;
  for (let i = 0; i < 40; i += 1) avg = foldResponseTime(avg, 60);
  assert.ok(avg > 55, `a long run of slow replies should converge, got ${avg}`);
});

test("a nonsense sample leaves the average alone", () => {
  assert.equal(foldResponseTime(12, -1), 12);
  assert.equal(foldResponseTime(12, NaN), 12);
  assert.equal(foldResponseTime(12, undefined), 12);
});
