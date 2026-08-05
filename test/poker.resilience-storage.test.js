"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { RedisTableStateStore } = require("../utils/tableStateStore");
const presence = require("../services/socketPresenceService");

function makeFencedRedis() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) || null; },
    async eval(_script, { keys, arguments: args }) {
      const key = keys[0];
      const existing = values.get(key);
      if (existing && Number(JSON.parse(existing).ownerFence || 0) > Number(args[1])) return 0;
      values.set(key, args[0]);
      return 1;
    },
  };
}

test("encrypted snapshots reject a stale owner fence and round-trip only with the key", async () => {
  const oldKey = process.env.POKER_SNAPSHOT_ENCRYPTION_KEY;
  process.env.POKER_SNAPSHOT_ENCRYPTION_KEY = "test-snapshot-secret";
  const redis = makeFencedRedis();
  const store = new RedisTableStateStore(redis);
  try {
    assert.equal(await store.save("table-a", { hole: ["Ah", "Ad"], handId: "h1" }, { ownerFence: 8 }), true);
    const raw = await redis.get("table_state:table-a");
    assert.equal(raw.includes("Ah"), false, "private cards are not stored as plaintext");
    assert.deepEqual(await store.load("table-a"), {
      hole: ["Ah", "Ad"],
      handId: "h1",
      ownerFence: 8,
    });
    assert.equal(
      await store.save("table-a", { hole: ["Ks", "Kd"] }, { ownerFence: 7 }),
      false,
      "a former owner cannot overwrite the newer snapshot"
    );
  } finally {
    if (oldKey === undefined) delete process.env.POKER_SNAPSHOT_ENCRYPTION_KEY;
    else process.env.POKER_SNAPSHOT_ENCRYPTION_KEY = oldKey;
  }
});

test("socket presence is idempotent per socket and retains another active device", async () => {
  presence.setRedisClient(null);
  const tableId = `presence-${Date.now()}`;
  assert.equal(await presence.registerSocket(tableId, "u1", "socket-a"), 1);
  assert.equal(await presence.registerSocket(tableId, "u1", "socket-a"), 1);
  assert.equal(await presence.registerSocket(tableId, "u1", "socket-b"), 2);
  assert.equal(await presence.releaseSocket(tableId, "u1", "socket-a"), 1);
  assert.equal(await presence.releaseSocket(tableId, "u1", "socket-b"), 0);
});
