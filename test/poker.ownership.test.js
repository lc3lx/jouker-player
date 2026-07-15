"use strict";

/**
 * H-3 ownership manager unit tests — exercised against a fake Redis that
 * faithfully models SET NX PX, INCR, GET, DEL, PEXPIRE + key expiry, so the
 * single-owner / fencing / failover guarantees are verified deterministically.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RedisTableOwnershipManager,
  InMemoryTableOwnershipManager,
  parseFence,
  parseInstance,
} = require("../services/pokerTableOwnership");

/** Minimal Redis stub supporting the ownership manager's command surface. */
function makeFakeRedis() {
  const store = new Map(); // key -> { value, expireAt|null }
  const now = () => Date.now();
  const alive = (key) => {
    const e = store.get(key);
    if (!e) return false;
    if (e.expireAt != null && e.expireAt <= now()) {
      store.delete(key);
      return false;
    }
    return true;
  };
  return {
    store,
    async incr(key) {
      const cur = alive(key) ? Number(store.get(key).value) : 0;
      const next = cur + 1;
      store.set(key, { value: String(next), expireAt: null });
      return next;
    },
    async set(key, value, opts = {}) {
      if (opts.NX && alive(key)) return null;
      const expireAt = opts.PX ? now() + opts.PX : null;
      store.set(key, { value, expireAt });
      return "OK";
    },
    async get(key) {
      return alive(key) ? store.get(key).value : null;
    },
    async eval(lua, { keys, arguments: args }) {
      const key = keys[0];
      const cur = alive(key) ? store.get(key).value : null;
      if (cur !== args[0]) return 0;
      if (lua.includes("PEXPIRE")) {
        store.get(key).expireAt = now() + Number(args[1]);
        return 1;
      }
      store.delete(key);
      return 1;
    },
    /** Test helper: force a lease to look expired. */
    forceExpire(key) {
      if (store.has(key)) store.get(key).expireAt = now() - 1;
    },
  };
}

test("parse helpers split instanceId and fence", () => {
  assert.equal(parseInstance("inst-A:42"), "inst-A");
  assert.equal(parseFence("inst-A:42"), 42);
  assert.equal(parseInstance("pid:123:abcd:7"), "pid:123:abcd");
  assert.equal(parseFence(null), null);
});

test("single owner: only one of two instances acquires the same table", async () => {
  const redis = makeFakeRedis();
  const a = new RedisTableOwnershipManager(redis, { instanceId: "A", leaseTtlMs: 5000 });
  const b = new RedisTableOwnershipManager(redis, { instanceId: "B", leaseTtlMs: 5000 });

  const ra = await a.acquire("t1");
  const rb = await b.acquire("t1");

  assert.equal(ra.owned, true);
  assert.equal(rb.owned, false);
  assert.equal(rb.ownerId, "A", "loser learns the real owner for forwarding");
  assert.equal(a.ownsLocally("t1"), true);
  assert.equal(b.ownsLocally("t1"), false);
  assert.equal(await b.currentOwner("t1"), "A");
});

test("re-acquire by the current owner is an idempotent success (renew)", async () => {
  const redis = makeFakeRedis();
  const a = new RedisTableOwnershipManager(redis, { instanceId: "A", leaseTtlMs: 5000 });
  const first = await a.acquire("t2");
  const second = await a.acquire("t2");
  assert.equal(first.owned, true);
  assert.equal(second.owned, true);
  assert.equal(second.fence, first.fence, "no new fence when we already hold it");
});

test("renew is token-checked: a stale holder cannot extend a reclaimed lease", async () => {
  const redis = makeFakeRedis();
  const a = new RedisTableOwnershipManager(redis, { instanceId: "A", leaseTtlMs: 5000 });
  const b = new RedisTableOwnershipManager(redis, { instanceId: "B", leaseTtlMs: 5000 });

  await a.acquire("t3");
  // A's lease expires; B claims it.
  redis.forceExpire("poker:owner:table:t3");
  const rb = await b.acquire("t3");
  assert.equal(rb.owned, true);

  // A (a "zombie") tries to renew — must fail and drop its local claim.
  const renewed = await a.renew("t3");
  assert.equal(renewed, false);
  assert.equal(a.ownsLocally("t3"), false, "zombie demotes itself");
  assert.equal(await a.currentOwner("t3"), "B");
});

test("failover: after lease expiry a new instance acquires with a higher fence", async () => {
  const redis = makeFakeRedis();
  const a = new RedisTableOwnershipManager(redis, { instanceId: "A", leaseTtlMs: 5000 });
  const b = new RedisTableOwnershipManager(redis, { instanceId: "B", leaseTtlMs: 5000 });

  const ra = await a.acquire("t4");
  redis.forceExpire("poker:owner:table:t4"); // simulate A crash (kill -9)
  const rb = await b.acquire("t4");

  assert.equal(rb.owned, true);
  assert.ok(rb.fence > ra.fence, "monotonic fence increases across ownership transfer");
});

test("release frees the lease so another instance can take over immediately", async () => {
  const redis = makeFakeRedis();
  const a = new RedisTableOwnershipManager(redis, { instanceId: "A", leaseTtlMs: 5000 });
  const b = new RedisTableOwnershipManager(redis, { instanceId: "B", leaseTtlMs: 5000 });

  await a.acquire("t5");
  await a.release("t5");
  assert.equal(a.ownsLocally("t5"), false);

  const rb = await b.acquire("t5");
  assert.equal(rb.owned, true, "graceful handoff on clean shutdown");
});

test("release is token-checked: A cannot delete B's lease", async () => {
  const redis = makeFakeRedis();
  const a = new RedisTableOwnershipManager(redis, { instanceId: "A", leaseTtlMs: 5000 });
  const b = new RedisTableOwnershipManager(redis, { instanceId: "B", leaseTtlMs: 5000 });

  await a.acquire("t6");
  redis.forceExpire("poker:owner:table:t6");
  await b.acquire("t6");

  await a.release("t6"); // A thinks it still owns — must NOT delete B's lease
  assert.equal(await b.currentOwner("t6"), "B", "B keeps ownership");
  assert.equal(b.ownsLocally("t6"), true);
});

test("split-brain attempt: concurrent acquires never both win", async () => {
  const redis = makeFakeRedis();
  const mgrs = Array.from(
    { length: 8 },
    (_, i) => new RedisTableOwnershipManager(redis, { instanceId: `I${i}`, leaseTtlMs: 5000 })
  );
  const results = await Promise.all(mgrs.map((m) => m.acquire("hot")));
  const winners = results.filter((r) => r.owned);
  assert.equal(winners.length, 1, "exactly one owner under concurrent contention");
  const ownerId = await mgrs[0].currentOwner("hot");
  assert.equal(results.filter((r) => !r.owned).every((r) => r.ownerId === ownerId), true);
});

test("in-memory manager always owns (single-instance fallback)", async () => {
  const m = new InMemoryTableOwnershipManager({ instanceId: "solo" });
  const r = await m.acquire("x");
  assert.equal(r.owned, true);
  assert.equal(await m.renew("x"), true);
  assert.equal(m.ownsLocally("x"), true);
  assert.deepEqual(m.ownedTableIds(), ["x"]);
  await m.release("x");
  assert.equal(m.ownsLocally("x"), false);
});

// ─── isOwner gating on the engine (a follower's loop is inert) ────────────────

const { PokerTable, GameRegistry } = require("../sockets/tableGame");

function nspStub() {
  return {
    to() {
      return { emit() {} };
    },
    in() {
      return { async fetchSockets() { return []; } };
    },
  };
}

function tableDocStub(id = "own-t") {
  return {
    _id: id,
    smallBlind: 100,
    bigBlind: 200,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 9,
    seats: [
      { user: { _id: "u0", name: "P0" }, chips: 10000 },
      { user: { _id: "u1", name: "P1" }, chips: 10000 },
    ],
  };
}

test("follower engine (isOwner=false) never runs the autonomous loop", async () => {
  const g = new PokerTable(nspStub(), tableDocStub());
  g.saveSnapshot = async () => {};
  g.syncMongoTableStatus = async () => {};
  g.applyCosmeticsToSeats = async () => {};
  g.broadcastState = async () => {};
  g.isOwner = false;

  await g.startHand();
  assert.equal(g.round, "idle", "follower does not deal");
  assert.equal(g.running, false);

  await g.startIfReady({ refreshFromDb: false });
  assert.equal(g.running, false, "follower never starts a hand");

  await g.bootstrapLobbyStart();
  assert.equal(g.running, false);

  g.running = true;
  g.currentIndex = 0;
  g.scheduleCurrentTurn();
  assert.equal(g.turnTimer, null, "follower schedules no turn timer");
  g.scheduleNextHand();
  assert.equal(g.nextHandTimer, null, "follower schedules no next-hand timer");
  g.running = false;

  // Owner flips back on and the loop works again.
  g.isOwner = true;
  g.running = true;
  g.currentIndex = 0;
  g.seats[0].inHand = true;
  g.scheduleCurrentTurn();
  assert.ok(g.turnTimer || g.botThinkTimer || g.actionDeadline, "owner schedules the turn");
  g.disposeTimers();
});

test("registry heartbeat demotes a table whose lease we lost", async () => {
  let renewResult = true;
  const fakeOwnership = {
    instanceId: "A",
    leaseTtlMs: 6000,
    isEnabled: () => true,
    async renew() {
      return renewResult;
    },
    async acquire() {
      return { owned: false };
    },
    ownedTableIds: () => [],
  };
  const registry = new GameRegistry(nspStub(), { ownership: fakeOwnership });

  const disposed = { count: 0 };
  const fakeGame = {
    isOwner: true,
    running: true,
    starting: false,
    disposeTimers() {
      disposed.count += 1;
    },
  };
  registry.map.set("t-demote", { game: fakeGame, lastAccessAt: Date.now() });

  // Heartbeat while we still hold the lease → no demotion.
  await registry._heartbeat();
  assert.equal(registry.map.has("t-demote"), true);
  assert.equal(fakeGame.isOwner, true);

  // Lease lost → demote (dispose timers, drop from map).
  renewResult = false;
  await registry._heartbeat();
  assert.equal(registry.map.has("t-demote"), false, "demoted table removed from map");
  assert.equal(fakeGame.isOwner, false);
  assert.equal(disposed.count, 1, "timers disposed on demotion");
});

test("registry sweep promotes a follower copy after the owner dies", async () => {
  let acquireOwned = false;
  const fakeOwnership = {
    instanceId: "B",
    leaseTtlMs: 6000,
    isEnabled: () => true,
    async renew() {
      return true;
    },
    async acquire() {
      return { owned: acquireOwned, fence: 7 };
    },
    ownedTableIds: () => [],
  };
  const registry = new GameRegistry(nspStub(), { ownership: fakeOwnership });

  const promoted = { called: false };
  const followerGame = { isOwner: false };
  registry.map.set("t-promote", { game: followerGame, lastAccessAt: Date.now() });
  // Stub the heavy Mongo/restore path — we only assert the promotion decision.
  registry._promote = async (tid, own) => {
    promoted.called = true;
    promoted.fence = own.fence;
    registry.map.get(tid).game.isOwner = true;
  };

  // Owner still alive → acquire fails → no promotion.
  await registry._sweep();
  assert.equal(promoted.called, false);
  assert.equal(followerGame.isOwner, false);

  // Owner died, lease free → acquire wins → promote.
  acquireOwned = true;
  await registry._sweep();
  assert.equal(promoted.called, true, "follower promoted on ownerless table");
  assert.equal(promoted.fence, 7);
  assert.equal(followerGame.isOwner, true);
});
