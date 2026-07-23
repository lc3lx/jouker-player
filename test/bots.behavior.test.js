"use strict";

/**
 * Bot behavior tuning — proves personality/skill change decisions and timing,
 * AND that the existing card-bot functions are byte-identical when called with no
 * opts (the regression guard that keeps current gameplay tests passing).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const behavior = require("../services/botBehaviorService");
const TrixBot = require("../engine/bots/TrixBot");
const TarneebBot = require("../engine/bots/TarneebBot");

test("tuningFor merges personality + skill tables", () => {
  const aggr = behavior.tuningFor("aggressive", "expert");
  assert.ok(aggr.raiseMul > 1.5, "aggressive raises more");
  assert.equal(aggr.mistakeRate, 0, "expert never misplays");
  const beginner = behavior.tuningFor("passive", "easy");
  assert.ok(beginner.mistakeRate > 0.2, "easy skill misplays often");
});

test("thinkDelay is randomized and bounded, scaled by personality", () => {
  behavior.applySettings({ thinkMinMs: 800, thinkMaxMs: 3200 });
  const samples = Array.from({ length: 50 }, () =>
    behavior.thinkDelay({ personality: "professional", skill: "normal", actionType: "act" })
  );
  const uniq = new Set(samples);
  assert.ok(uniq.size > 5, "delays are randomized, not constant");
  for (const d of samples) assert.ok(d >= 250, "never below the floor");

  // Aggressive (fast) should average lower than passive (slow).
  const avg = (p) => {
    const t = behavior.tuningFor(p, "normal");
    let sum = 0;
    for (let i = 0; i < 200; i++) sum += behavior.thinkDelay({ personality: p, skill: "normal", tuning: t });
    return sum / 200;
  };
  assert.ok(avg("aggressive") < avg("passive"), "aggressive thinks faster than passive");
});

test("pokerThreshold scales by kind; no tuning returns the base unchanged", () => {
  assert.equal(behavior.pokerThreshold(0.22, null, "raise"), 0.22, "null tuning = identity");
  const aggr = behavior.tuningFor("aggressive", "normal");
  assert.ok(behavior.pokerThreshold(0.22, aggr, "raise") > 0.22, "aggressive raises more often");
  const passive = behavior.tuningFor("passive", "normal");
  assert.ok(behavior.pokerThreshold(0.22, passive, "raise") < 0.22, "passive raises less often");
  // Always clamped to [0,1].
  assert.ok(behavior.pokerThreshold(0.9, aggr, "raise") <= 1);
});

test("shouldMisplay: expert never, easy sometimes", () => {
  for (let i = 0; i < 100; i++) assert.equal(behavior.shouldMisplay("expert"), false);
  let misplays = 0;
  for (let i = 0; i < 400; i++) if (behavior.shouldMisplay("easy")) misplays++;
  assert.ok(misplays > 40, "easy skill misplays a meaningful fraction of the time");
});

// ── REGRESSION: default (no opts) card-bot output is unchanged ────────────────

test("TrixBot.botChooseCard default behavior is unchanged (no opts)", () => {
  // Follow suit → still lowest card.
  const gs = { currentGameType: "Diamonds", leadingSuit: "Hearts", tableCards: [{}] };
  const valid = [
    { suit: "Hearts", rank: "2", value: 2 },
    { suit: "Hearts", rank: "A", value: 14 },
  ];
  for (let i = 0; i < 20; i++) {
    assert.equal(TrixBot.botChooseCard(gs, 0, valid).value, 2, "lowest follow card, deterministically");
  }
});

test("TarneebBot default bid + card are unchanged (no opts)", () => {
  const hand = [
    { rank: 14, suit: "S" },
    { rank: 13, suit: "S" },
    { rank: 12, suit: "H" },
  ];
  for (let i = 0; i < 20; i++) assert.equal(TarneebBot.botBid(hand, "S"), 3, "deterministic bid");
  const rules = { getValidCards: (h) => h };
  for (let i = 0; i < 20; i++) {
    assert.equal(TarneebBot.pickAutoPlayCard([{ rank: 5 }, { rank: 2 }, { rank: 9 }], null, rules).rank, 2);
  }
});

test("expert opts still play optimally (mistakeRate 0)", () => {
  const opts = { personality: "professional", skill: "expert", tuning: behavior.tuningFor("professional", "expert") };
  const rules = { getValidCards: (h) => h };
  for (let i = 0; i < 30; i++) {
    assert.equal(
      TarneebBot.pickAutoPlayCard([{ rank: 5 }, { rank: 2 }, { rank: 9 }], null, rules, opts).rank,
      2,
      "expert always plays lowest — never a mistake"
    );
  }
});

test("low-skill opts sometimes deviate from the optimal card", () => {
  const opts = { personality: "beginner", skill: "easy", tuning: behavior.tuningFor("beginner", "easy") };
  const rules = { getValidCards: (h) => h };
  let deviations = 0;
  for (let i = 0; i < 300; i++) {
    const c = TarneebBot.pickAutoPlayCard([{ rank: 5 }, { rank: 2 }, { rank: 9 }], null, rules, opts);
    if (c.rank !== 2) deviations++;
  }
  assert.ok(deviations > 20, "easy bots occasionally play a non-optimal card");
});
