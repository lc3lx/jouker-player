/**
 * Friends — integration tests over the real service + model against a throwaway
 * local MongoDB. Skipped automatically when no local Mongo is reachable.
 *
 * The headline regression: Friendship declared
 * `index({ users: 1 }, { unique: true })`. `users` is an array, so Mongo built a
 * MULTIKEY unique index and enforced uniqueness per ELEMENT, not per pair — once
 * a user was in one friendship, every later one containing them failed with
 * E11000. Every account was capped at exactly one friend and the second accept
 * returned a 500.
 */
process.env.NODE_ENV = "test";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const MONGO_URI = `mongodb://127.0.0.1:27017/friends_test_${process.pid}`;

let mongoAvailable = false;
let User;
let Friendship;
let FriendRequest;
let friendService;

before(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
    mongoAvailable = true;
  } catch (_) {
    return;
  }
  User = require("../models/userModel");
  Friendship = require("../models/friendshipModel");
  FriendRequest = require("../models/friendRequestModel");
  friendService = require("../services/friendService");
  const { ensureFriendshipIndexes } = require("../services/friendSchemaService");
  await ensureFriendshipIndexes();
});

after(async () => {
  if (!mongoAvailable) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

function guarded(name, fn) {
  test(name, async (t) => {
    if (!mongoAvailable) {
      t.skip("no local MongoDB");
      return;
    }
    await fn(t);
  });
}

let seq = 0;
async function mkUser(extra = {}) {
  seq += 1;
  return User.create({
    name: `Player${seq}`,
    email: `player${seq}.${process.pid}@test.local`,
    password: "secret123",
    role: "user",
    ...extra,
  });
}

guarded("a player can collect several friends", async () => {
  const [me, a, b, c] = await Promise.all([mkUser(), mkUser(), mkUser(), mkUser()]);

  for (const other of [a, b, c]) {
    const req = await friendService.sendFriendRequest(me._id, other._id);
    await friendService.acceptFriendRequest(other._id, req._id);
  }

  const friends = await friendService.listFriends(me._id);
  assert.equal(friends.length, 3, "all three accepts produced a friendship");
  const ids = friends.map((f) => f.userId).sort();
  assert.deepEqual(ids, [a, b, c].map((u) => String(u._id)).sort());
});

guarded("friendships are stored once per pair, in either direction", async () => {
  const [a, b] = await Promise.all([mkUser(), mkUser()]);

  const req = await friendService.sendFriendRequest(a._id, b._id);
  await friendService.acceptFriendRequest(b._id, req._id);

  // The reverse pair must not be insertable as a second row.
  const sorted = [a._id, b._id].sort((x, y) => (String(x) < String(y) ? -1 : 1));
  await assert.rejects(
    () => Friendship.create({ users: [sorted[1], sorted[0]] }),
    (e) => e.code === 11000
  );

  const rows = await Friendship.find({ users: a._id });
  assert.equal(rows.length, 1);
});

guarded("accepting clears the mirrored request from the other side", async () => {
  const [a, b] = await Promise.all([mkUser(), mkUser()]);

  const outgoing = await friendService.sendFriendRequest(a._id, b._id);
  const mirrored = await friendService.sendFriendRequest(b._id, a._id);

  await friendService.acceptFriendRequest(b._id, outgoing._id);

  const stale = await FriendRequest.findById(mirrored._id).lean();
  assert.equal(
    stale.status,
    "cancelled",
    "no leftover request offering to befriend an existing friend"
  );
  const pending = await friendService.listPendingRequests(a._id);
  assert.equal(pending.incoming.length, 0);
  assert.equal(pending.outgoing.length, 0);
});

guarded("a request can be sent to a player whose active flag was never set", async () => {
  const [me, legacy] = await Promise.all([mkUser(), mkUser()]);
  // Predates the `active` field — searchUsers lists these, so add must accept them.
  await User.collection.updateOne({ _id: legacy._id }, { $unset: { active: "" } });

  const found = await friendService.searchUsers(me._id, legacy.name);
  assert.ok(
    found.some((u) => u.id === String(legacy._id)),
    "the player is findable"
  );

  const req = await friendService.sendFriendRequest(me._id, legacy._id);
  assert.equal(String(req.to), String(legacy._id));
});

guarded("a deactivated player cannot be added", async () => {
  const [me, gone] = await Promise.all([mkUser(), mkUser({ active: false })]);
  await assert.rejects(
    () => friendService.sendFriendRequest(me._id, gone._id),
    (e) => e.statusCode === 404
  );
});

guarded("concurrent accepts of the same pair settle on one friendship", async () => {
  const [a, b] = await Promise.all([mkUser(), mkUser()]);
  const one = await friendService.sendFriendRequest(a._id, b._id);
  const two = await friendService.sendFriendRequest(b._id, a._id);

  const results = await Promise.allSettled([
    friendService.acceptFriendRequest(b._id, one._id),
    friendService.acceptFriendRequest(a._id, two._id),
  ]);
  assert.ok(
    results.every((r) => r.status === "fulfilled"),
    `both accepts resolve: ${results.map((r) => r.reason?.message).join(" | ")}`
  );

  const rows = await Friendship.find({ users: a._id });
  assert.equal(rows.length, 1, "exactly one friendship row");
  const friends = await friendService.listFriends(a._id);
  assert.equal(friends.length, 1);
});

guarded("relationship reflects pending, friend, and none", async () => {
  const [a, b] = await Promise.all([mkUser(), mkUser()]);

  assert.equal((await friendService.getRelationship(a._id, b._id)).requestPending, "none");

  const req = await friendService.sendFriendRequest(a._id, b._id);
  assert.equal((await friendService.getRelationship(a._id, b._id)).requestPending, "outgoing");
  assert.equal((await friendService.getRelationship(b._id, a._id)).requestPending, "incoming");

  await friendService.acceptFriendRequest(b._id, req._id);
  const after = await friendService.getRelationship(a._id, b._id);
  assert.equal(after.isFriend, true);
  assert.equal(after.requestPending, "none");
});

guarded("removing a friend frees the pair to be re-added", async () => {
  const [a, b] = await Promise.all([mkUser(), mkUser()]);
  const req = await friendService.sendFriendRequest(a._id, b._id);
  await friendService.acceptFriendRequest(b._id, req._id);

  await friendService.removeFriend(a._id, b._id);
  assert.equal((await friendService.listFriends(a._id)).length, 0);

  const again = await friendService.sendFriendRequest(a._id, b._id);
  await friendService.acceptFriendRequest(b._id, again._id);
  assert.equal((await friendService.listFriends(a._id)).length, 1);
});

guarded("the legacy per-user unique index is repaired on boot", async () => {
  const coll = Friendship.collection;
  // Put the broken index back exactly as older deployments have it. The old
  // index cannot build over rows this suite already created (that is the bug),
  // so start from an empty collection.
  await coll.deleteMany({});
  await coll.dropIndexes();
  await coll.createIndex({ users: 1 }, { unique: true, name: "users_1" });

  // The repair runs once per process; reload it so boot can be re-exercised.
  delete require.cache[require.resolve("../services/friendSchemaService")];
  await require("../services/friendSchemaService").ensureFriendshipIndexes();

  const names = (await coll.indexes()).map((i) => i.name);
  assert.ok(!names.includes("users_1"), "the multikey unique index is gone");
  assert.ok(names.includes("users_pair_unique"), "the pair index replaced it");

  const [a, b, c] = await Promise.all([mkUser(), mkUser(), mkUser()]);
  for (const other of [b, c]) {
    const req = await friendService.sendFriendRequest(a._id, other._id);
    await friendService.acceptFriendRequest(other._id, req._id);
  }
  assert.equal((await friendService.listFriends(a._id)).length, 2);
});
