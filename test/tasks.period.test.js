"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  _periodMeta: periodMeta,
  _mapTaskRow: mapTaskRow,
  _TASK_DEFINITIONS: TASK_DEFINITIONS,
} = require("../services/taskService");

describe("tasks period + mapping", () => {
  it("weekly since aligns to ISO week Monday (not rolling 7d)", () => {
    // 2026-08-10 is Monday → week start is same day
    const mon = periodMeta("weekly", new Date("2026-08-10T15:00:00Z"));
    assert.equal(mon.periodKey, "2026-W33");
    assert.equal(mon.since.toISOString().slice(0, 10), "2026-08-10");

    // 2026-08-12 is Wednesday → week start still Monday 10th
    const wed = periodMeta("weekly", new Date("2026-08-12T12:00:00Z"));
    assert.equal(wed.periodKey, "2026-W33");
    assert.equal(wed.since.toISOString().slice(0, 10), "2026-08-10");
  });

  it("daily period uses UTC day start", () => {
    const meta = periodMeta("daily", new Date("2026-08-10T20:30:00Z"));
    assert.equal(meta.period, "daily");
    assert.equal(meta.periodKey, "2026-08-10");
    assert.equal(meta.since.toISOString(), "2026-08-10T00:00:00.000Z");
  });

  it("exposes daily/weekly/seasonal definitions", () => {
    assert.ok(TASK_DEFINITIONS.daily.length >= 1);
    assert.ok(TASK_DEFINITIONS.weekly.length >= 1);
    assert.ok(TASK_DEFINITIONS.seasonal.length >= 1);
  });

  it("mapTaskRow marks completed and clamps progress", () => {
    const def = TASK_DEFINITIONS.daily[0];
    const done = mapTaskRow(def, def.target + 5, false);
    assert.equal(done.isCompleted, true);
    assert.equal(done.isClaimed, false);
    assert.equal(done.currentProgress, def.target);
    assert.equal(done.progress, 1);

    const claimed = mapTaskRow(def, def.target, true);
    assert.equal(claimed.isClaimed, true);
  });
});
