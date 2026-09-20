/**
 * Two bugs on the path a player takes when their socket reconnects to a poker
 * table they are still holding a seat at, both of which were silent.
 *
 * Reported as: subscribed to VIP, made a table, could not sit, every seat read
 * "فارغ", and the client showed "Your table session has ended".
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  joinGateDecision,
  shouldRegisterSeatPresence,
} = require("../services/pokerVacateService");

// ── the gate ──────────────────────────────────────────────────────────────
//
// `handleJoinTable` had two gates in a row. The first let `isVacating` through,
// the second rejected exactly that case with `not_seated` — so the vacating arm
// of the first gate was dead, and the seat restore its own comment described
// had never been written. A player reconnecting inside the grace window they
// had paid to hold was told their session had ended.

test("a seated player joins", () => {
  assert.equal(
    joinGateDecision({ isSeated: true, isVacating: false }),
    "join"
  );
});

test("a player inside the vacate window gets a restore, not a rejection", () => {
  // This is the assertion that fails against the old code, which returned
  // `not_seated` here.
  assert.equal(
    joinGateDecision({ isSeated: false, isVacating: true }),
    "restore"
  );
});

test("a stranger is rejected", () => {
  assert.equal(
    joinGateDecision({ isSeated: false, isVacating: false }),
    "reject"
  );
});

test("being seated wins over a stale vacate entry", () => {
  // Restoring a seat the player already occupies would push a duplicate seat.
  assert.equal(joinGateDecision({ isSeated: true, isVacating: true }), "join");
});

test("the vacating arm is reachable, which is the whole point", () => {
  const outcomes = new Set(
    [true, false].flatMap((isSeated) =>
      [true, false].map((isVacating) =>
        joinGateDecision({ isSeated, isVacating })
      )
    )
  );
  assert.ok(
    outcomes.has("restore"),
    "no input produces a restore — the branch is dead again"
  );
});

// ── presence registration ────────────────────────────────────────────────
//
// The condition was `String(clientIp).trim().isNotEmpty` — Dart syntax in a
// JavaScript file. JS strings have no `isNotEmpty`, so it evaluated to
// `undefined` rather than throwing, and the condition collapsed to `deviceId`
// alone. Restores carrying an IP but no device id skipped presence
// registration, and the collusion guard lost that seat.

test("an IP alone is enough to register presence", () => {
  // The case the Dart-ism silently dropped.
  assert.equal(shouldRegisterSeatPresence("203.0.113.7", null), true);
});

test("a device id alone is enough", () => {
  assert.equal(shouldRegisterSeatPresence(null, "device-abc"), true);
});

test("neither means nothing to register", () => {
  assert.equal(shouldRegisterSeatPresence(null, null), false);
  assert.equal(shouldRegisterSeatPresence("", ""), false);
});

test("whitespace is not an identity", () => {
  assert.equal(shouldRegisterSeatPresence("   ", "  "), false);
  assert.equal(shouldRegisterSeatPresence("   ", "device-abc"), true);
});

test("the predicate returns a real boolean, never undefined", () => {
  // `undefined` is what the old expression produced, and it read as false
  // everywhere without ever looking wrong.
  for (const args of [
    ["1.2.3.4", null],
    [null, null],
    [null, "d"],
    ["", "d"],
  ]) {
    assert.equal(
      typeof shouldRegisterSeatPresence(...args),
      "boolean",
      `not a boolean for ${JSON.stringify(args)}`
    );
  }
});

console.log("poker.socketReconnectRestore.test.js: all tests registered");
