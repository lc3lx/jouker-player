const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHandAuditLog } = require("../services/handHistoryAuditService");
const { auditChipConservation, auditOrFreeze } = require("../utils/poker/chipAuditor");
const { derivePokerTableStatus } = require("../utils/pokerTableStatus");
const pokerQueueRedis = require("../utils/redis/pokerQueueRedis");
const {
  assertNoCollusionAtPublicTable,
  normalizeIp,
  normalizeDeviceId,
} = require("../services/pokerCollusionGuard");

test("buildHandAuditLog formats blinds and streets chronologically", () => {
  const seats = [
    { userId: "u1", name: "Alice", seatIndex: 0 },
    { userId: "u2", name: "Bob", seatIndex: 1 },
  ];
  const actions = [
    { ts: 1, round: "preflop", type: "blind", playerId: "u1", seatIndex: 0, amount: 500, blind: "SB" },
    { ts: 2, round: "preflop", type: "blind", playerId: "u2", seatIndex: 1, amount: 1000, blind: "BB" },
    { ts: 3, round: "preflop", type: "raise", playerId: "u1", seatIndex: 0, amount: 2000 },
    { ts: 4, round: "flop", type: "street", street: "flop" },
  ];
  const community = ["As", "Kd", "2c"];
  const log = buildHandAuditLog(actions, seats, community);
  assert.ok(log.length >= 4);
  assert.match(log[0].message, /Alice.*Small Blind 500/);
  assert.match(log[1].message, /Bob.*Big Blind 1000/);
  assert.match(log[2].message, /Alice.*Raise 2000/);
  assert.match(log[3].message, /Flop Dealt/);
});

test("auditChipConservation detects delta", () => {
  const game = {
    seats: [{ chips: 9000, bet: 0 }],
    pot: 500,
    handStartTotal: 10000,
    uncollectedRake: 0,
  };
  const r = auditChipConservation(game, "test");
  assert.equal(r.ok, false);
  assert.equal(r.delta, -500);
});

test("auditChipConservation passes after blinds with immediate-pot model", () => {
  const game = {
    seats: [
      { chips: 9900, bet: 100 },
      { chips: 9800, bet: 200 },
    ],
    pot: 300,
    handStartTotal: 20000,
    uncollectedRake: 0,
  };
  const r = auditChipConservation(game, "post_blinds");
  assert.equal(r.ok, true);
  assert.equal(r.actual, 20000);
});

test("auditOrFreeze halts running game on violation", async () => {
  const broadcasts = [];
  const game = {
    tableId: "t1",
    currentHandId: "h1",
    frozen: false,
    running: true,
    seats: [{ chips: 1000, bet: 0 }],
    pot: 0,
    handStartTotal: 2000,
    uncollectedRake: 0,
    clearActionScheduling() {},
    clearTurnTimer() {},
    clearBotFillTimer() {},
    broadcastState: async () => {
      broadcasts.push(1);
    },
  };
  const ok = await auditOrFreeze(game, "unit_test");
  assert.equal(ok, false);
  assert.equal(game.frozen, true);
  assert.equal(game.running, false);
  assert.equal(game.tableStatusOverride, "frozen");
  assert.equal(broadcasts.length, 1);
});

test("derivePokerTableStatus returns frozen when flagged", () => {
  assert.equal(
    derivePokerTableStatus({ mongoSeatCount: 2, capacity: 9, running: true, round: "flop", frozen: true }),
    "frozen"
  );
});

test("pokerQueueRedis is disabled without client", async () => {
  pokerQueueRedis.setRedisClient(null);
  assert.equal(pokerQueueRedis.isEnabled(), false);
  assert.equal(await pokerQueueRedis.getQueueLength("tid"), 0);
});

test("collusion guard normalizes ip and deviceId", () => {
  assert.equal(normalizeIp("  192.168.1.1, 10.0.0.1 "), "192.168.1.1");
  assert.equal(normalizeDeviceId("short"), null);
  assert.equal(normalizeDeviceId("abcdefgh-1234-uuid"), "abcdefgh-1234-uuid");
});

test("time sync route returns serverTime", async () => {
  const express = require("express");
  const timeRoute = require("../routes/timeRoute");
  const app = express();
  app.use("/api/v1/time", timeRoute);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/time/sync?clientTs=1000`);
    const body = await res.json();
    assert.equal(body.status, "success");
    assert.ok(body.data.serverTime > 0);
    assert.equal(body.data.turnSeconds, 20);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
