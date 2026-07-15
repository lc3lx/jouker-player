"use strict";

/**
 * H-3 end-to-end (registry level): two GameRegistry instances share one Redis
 * (ownership lease + state-store + locks) and one replica-set Mongo. Verifies
 * exactly-one-owner, follower passivity, and automatic failover promotion when
 * the owner dies — the core horizontal-scaling guarantees.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Table = require("../models/tableModel");
const { GameRegistry } = require("../sockets/tableGame");
const { RedisTableOwnershipManager } = require("../services/pokerTableOwnership");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

let replSet = null;
const savedEnv = {};
let tableSeq = 5000;

/** In-memory Redis covering ownership + state-store + lock command surfaces. */
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
  const api = {
    store,
    forceExpire(key) {
      if (store.has(key)) store.get(key).expireAt = now() - 1;
    },
    async incr(key) {
      const cur = alive(key) ? Number(store.get(key).value) : 0;
      const next = cur + 1;
      store.set(key, { value: String(next), expireAt: alive(key) ? store.get(key).expireAt : null });
      return next;
    },
    async set(key, value, opts = {}) {
      if (opts.NX && alive(key)) return null;
      const expireAt = opts.PX ? now() + opts.PX : opts.EX ? now() + opts.EX * 1000 : null;
      store.set(key, { value: String(value), expireAt });
      return "OK";
    },
    async get(key) {
      return alive(key) ? store.get(key).value : null;
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    async expire(key, sec) {
      if (!alive(key)) return 0;
      store.get(key).expireAt = now() + sec * 1000;
      return 1;
    },
    async persist(key) {
      if (!alive(key)) return 0;
      store.get(key).expireAt = null;
      return 1;
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
    multi() {
      const ops = [];
      const chain = {
        set: (k, v, o) => (ops.push(() => api.set(k, v, o)), chain),
        expire: (k, s) => (ops.push(() => api.expire(k, s)), chain),
        persist: (k) => (ops.push(() => api.persist(k)), chain),
        del: (k) => (ops.push(() => api.del(k)), chain),
        async exec() {
          const out = [];
          for (const op of ops) out.push(await op());
          return out;
        },
      };
      return chain;
    },
  };
  return api;
}

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

function mkRegistry(redis, instanceId) {
  const ownership = new RedisTableOwnershipManager(redis, { instanceId, leaseTtlMs: 5000 });
  return new GameRegistry(nspStub(), { redis, ownership });
}

async function seedTable(humanSeats = 0) {
  tableSeq += 1;
  const t = await Table.create({
    gameType: "poker",
    tier: "beginner",
    tableNumber: tableSeq,
    smallBlind: 100,
    bigBlind: 200,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 9,
    status: "waiting",
    seats: Array.from({ length: humanSeats }, (_, i) => ({
      user: new mongoose.Types.ObjectId(),
      chips: 10000,
      seatPosition: i,
    })),
  });
  return String(t._id);
}

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE", "NODE_ENV"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.NODE_ENV = "test";
  delete process.env.MONGO_STANDALONE;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "poker_multi_instance" });
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  resetMongoTransactionProbeForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("exactly one registry owns a table; the other is a passive follower", async () => {
  const redis = makeFakeRedis();
  const A = mkRegistry(redis, "A");
  const B = mkRegistry(redis, "B");
  const tid = await seedTable(0);

  const gA = await A.get(tid);
  const gB = await B.get(tid);

  assert.ok(gA && gB);
  const owners = [gA.isOwner, gB.isOwner].filter(Boolean);
  assert.equal(owners.length, 1, "exactly one owner across instances");
  assert.notEqual(gA.isOwner, gB.isOwner);
  assert.equal(gA.isOwner, true, "first acquirer owns");
  assert.equal(gB.isOwner, false, "second is a follower");

  A.stopOwnershipLoops();
  B.stopOwnershipLoops();
});

test("follower engine is inert: it never persists snapshots or starts hands", async () => {
  const redis = makeFakeRedis();
  const A = mkRegistry(redis, "A");
  const B = mkRegistry(redis, "B");
  const tid = await seedTable(0);

  await A.get(tid); // A owns
  const gB = await B.get(tid); // B follows
  assert.equal(gB.isOwner, false);

  // A follower's saveSnapshot / broadcastState are gated → they must not write.
  const before = redis.store.get(`table_state:${tid}`);
  await gB.saveSnapshot();
  await gB.broadcastState();
  const after = redis.store.get(`table_state:${tid}`);
  assert.deepEqual(after, before, "follower did not touch the owner's snapshot");

  await gB.startHand();
  assert.equal(gB.running, false, "follower never deals");

  A.stopOwnershipLoops();
  B.stopOwnershipLoops();
});

test("failover: when the owner dies, the follower's sweep promotes it", async () => {
  const redis = makeFakeRedis();
  const A = mkRegistry(redis, "A");
  const B = mkRegistry(redis, "B");
  const tid = await seedTable(0);

  const gA = await A.get(tid);
  const gB = await B.get(tid);
  assert.equal(gA.isOwner, true);
  assert.equal(gB.isOwner, false);

  // A crashes (kill -9): its heartbeat stops and the lease expires in Redis.
  A.stopOwnershipLoops();
  redis.forceExpire(`poker:owner:table:${tid}`);

  // B's failover sweep claims the ownerless table and promotes its copy.
  await B._sweep();
  assert.equal(gB.isOwner, true, "follower promoted to owner after failover");
  assert.equal(await B.ownership.currentOwner(tid), "B");

  // Now B persists snapshots as the authoritative owner.
  await gB.broadcastState();
  assert.ok(redis.store.get(`table_state:${tid}`), "new owner writes snapshots");

  B.stopOwnershipLoops();
});

test("heartbeat renews our lease so a live owner is never stolen", async () => {
  const redis = makeFakeRedis();
  const A = mkRegistry(redis, "A");
  const B = mkRegistry(redis, "B");
  const tid = await seedTable(0);

  const gA = await A.get(tid);
  assert.equal(gA.isOwner, true);

  // A heartbeats (renews) → still owner. B's sweep cannot steal a live lease.
  await A._heartbeat();
  await B.get(tid); // B follows
  await B._sweep();
  assert.equal(gA.isOwner, true, "live owner keeps ownership");
  assert.equal(await A.ownership.currentOwner(tid), "A");

  A.stopOwnershipLoops();
  B.stopOwnershipLoops();
});

test("a demoted owner stops persisting; the new owner takes over cleanly", async () => {
  const redis = makeFakeRedis();
  const A = mkRegistry(redis, "A");
  const B = mkRegistry(redis, "B");
  const tid = await seedTable(0);

  const gA = await A.get(tid);
  await B.get(tid);

  // Simulate a network partition: A loses its lease, B claims it.
  redis.forceExpire(`poker:owner:table:${tid}`);
  await B._sweep(); // B becomes owner

  // A's heartbeat now discovers the lost lease and demotes locally.
  await A._heartbeat();
  assert.equal(A.map.has(tid), false, "demoted owner drops the table");
  assert.equal(gA.isOwner, false, "old owner is no longer authoritative");

  A.stopOwnershipLoops();
  B.stopOwnershipLoops();
});
