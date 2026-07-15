"use strict";

/**
 * H-3 command bus routing tests — a follower forwards a mutating command to the
 * owner instance's inbox; the owner receives and dispatches it exactly once.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PokerTableCommandBus, inboxChannel } = require("../services/pokerTableCommandBus");

/** Fake node-redis pub/sub: publish delivers synchronously to subscribers. */
function makePubSubRedis() {
  const channels = new Map();
  const client = {
    duplicate() {
      return client;
    },
    async connect() {},
    on() {},
    async subscribe(channel, listener) {
      if (!channels.has(channel)) channels.set(channel, new Set());
      channels.get(channel).add(listener);
    },
    async unsubscribe(channel) {
      channels.delete(channel);
    },
    async publish(channel, message) {
      const ls = channels.get(channel);
      if (!ls) return 0;
      for (const l of ls) l(message);
      return ls.size;
    },
    async quit() {},
  };
  return client;
}

test("inboxChannel is per-instance", () => {
  assert.equal(inboxChannel("A"), "poker:cmd:A");
  assert.notEqual(inboxChannel("A"), inboxChannel("B"));
});

test("follower forwards a command to the owner's inbox exactly once", async () => {
  const redis = makePubSubRedis();
  const received = [];
  const ownerBus = new PokerTableCommandBus(redis, {
    instanceId: "OWNER",
    onCommand: async (cmd) => {
      received.push(cmd);
    },
  });
  const followerBus = new PokerTableCommandBus(redis, {
    instanceId: "FOLLOWER",
    onCommand: async () => {
      throw new Error("follower must not receive its own forward");
    },
  });
  await ownerBus.start();
  await followerBus.start();

  const ok = await followerBus.publishTo("OWNER", {
    type: "action",
    tableId: "t1",
    userId: "u1",
    socketId: "sock-1",
    payload: { action: "call", actionId: "a1" },
  });

  await new Promise((r) => setImmediate(r));

  assert.equal(ok, true);
  assert.equal(received.length, 1, "owner received exactly one command");
  assert.equal(received[0].type, "action");
  assert.equal(received[0].tableId, "t1");
  assert.equal(received[0].from, "FOLLOWER", "sender stamped for traceability");
  assert.equal(received[0].payload.action, "call");

  await ownerBus.stop();
  await followerBus.stop();
});

test("a command addressed to a different owner is not delivered to us", async () => {
  const redis = makePubSubRedis();
  let got = 0;
  const busA = new PokerTableCommandBus(redis, {
    instanceId: "A",
    onCommand: async () => {
      got += 1;
    },
  });
  await busA.start();

  // Publish to a non-existent owner "Z" — A must not receive it.
  await busA.publishTo("Z", { type: "action", tableId: "t", userId: "u" });
  await new Promise((r) => setImmediate(r));
  assert.equal(got, 0);

  await busA.stop();
});

test("malformed messages never crash the dispatcher", async () => {
  const redis = makePubSubRedis();
  let dispatched = 0;
  const bus = new PokerTableCommandBus(redis, {
    instanceId: "A",
    onCommand: async () => {
      dispatched += 1;
    },
  });
  await bus.start();
  // Publish raw invalid JSON straight to the inbox channel.
  await redis.publish(inboxChannel("A"), "{not-json");
  await new Promise((r) => setImmediate(r));
  assert.equal(dispatched, 0, "invalid payload ignored, no throw");
  await bus.stop();
});

test("disabled bus (no redis) is a safe no-op", async () => {
  const bus = new PokerTableCommandBus(null, { instanceId: "A", onCommand: async () => {} });
  assert.equal(bus.isEnabled(), false);
  await bus.start(); // no throw
  const ok = await bus.publishTo("B", { type: "x" });
  assert.equal(ok, false);
  await bus.stop();
});
