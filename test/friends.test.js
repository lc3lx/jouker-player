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
// Small enough that the cap test does not need a hundred accounts; no other test
// here holds more than one outgoing request open at a time.
process.env.FRIEND_REQUEST_MAX_PENDING = "3";

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

guarded("a sent request reaches the recipient's incoming list", async () => {
  const [from, to] = await Promise.all([mkUser(), mkUser()]);
  await friendService.sendFriendRequest(from._id, to._id);

  const forRecipient = await friendService.listPendingRequests(to._id);
  assert.equal(forRecipient.incoming.length, 1, "recipient must see the request");
  assert.equal(forRecipient.outgoing.length, 0);

  // The client reads the request id and the populated sender off these rows —
  // a missing `_id` or `from.name` leaves an un-actionable tile in the list.
  const row = forRecipient.incoming[0];
  assert.ok(row._id, "request id is what accept/reject is called with");
  assert.equal(String(row.from._id), String(from._id));
  assert.equal(row.from.name, from.name);
  assert.equal(row.status, "pending");

  const forSender = await friendService.listPendingRequests(from._id);
  assert.equal(forSender.outgoing.length, 1, "sender must see it as outgoing");
  assert.equal(forSender.incoming.length, 0);
  assert.equal(String(forSender.outgoing[0].to._id), String(to._id));
});

guarded("accepting clears the request from both players' lists", async () => {
  const [from, to] = await Promise.all([mkUser(), mkUser()]);
  const req = await friendService.sendFriendRequest(from._id, to._id);
  await friendService.acceptFriendRequest(to._id, req._id);

  const forRecipient = await friendService.listPendingRequests(to._id);
  const forSender = await friendService.listPendingRequests(from._id);
  assert.equal(forRecipient.incoming.length, 0);
  assert.equal(forSender.outgoing.length, 0);

  // And both now see each other as a friend.
  const mine = await friendService.listFriends(to._id);
  const theirs = await friendService.listFriends(from._id);
  assert.equal(mine.length, 1);
  assert.equal(theirs.length, 1);
});

guarded("accepting clears the mirrored request from the other side", async () => {
  const [a, b] = await Promise.all([mkUser(), mkUser()]);

  const outgoing = await friendService.sendFriendRequest(a._id, b._id);
  // Sending now accepts a mirrored request instead of creating one, so this
  // pair can only exist as data written before that — which still has to heal.
  const mirrored = await FriendRequest.create({ from: b._id, to: a._id, status: "pending" });

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
  // Legacy mirrored pair (see above): the service no longer creates one.
  const two = await FriendRequest.create({ from: b._id, to: a._id, status: "pending" });

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

guarded("two simultaneous sends leave exactly one pending request", async () => {
  const [a, b] = await Promise.all([mkUser(), mkUser()]);
  // A double tap, or the add button in the profile popup and the search dialog
  // at once. Both passed the "already sent?" read before either had written.
  const results = await Promise.allSettled([
    friendService.sendFriendRequest(a._id, b._id),
    friendService.sendFriendRequest(a._id, b._id),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.statusCode, 400);
  const pending = await FriendRequest.countDocuments({ from: a._id, to: b._id, status: "pending" });
  assert.equal(pending, 1);
});

guarded("adding a player who already asked you makes you friends", async () => {
  const [a, b] = await Promise.all([mkUser(), mkUser()]);
  const theirs = await friendService.sendFriendRequest(b._id, a._id);

  // The search dialog has no idea B already asked; pressing add must not park a
  // second, mirrored request next to the first.
  const result = await friendService.sendFriendRequest(a._id, b._id);
  assert.equal(String(result._id), String(theirs._id));
  assert.equal(result.status, "accepted");

  assert.equal((await friendService.listFriends(a._id)).length, 1);
  const open = await FriendRequest.countDocuments({
    status: "pending",
    $or: [{ from: a._id }, { to: a._id }],
  });
  assert.equal(open, 0);
});

guarded("an accept racing a cancel cannot both win", async () => {
  const [a, b] = await Promise.all([mkUser(), mkUser()]);
  const req = await friendService.sendFriendRequest(a._id, b._id);

  const [accept, cancel] = await Promise.allSettled([
    friendService.acceptFriendRequest(b._id, req._id),
    friendService.cancelFriendRequest(a._id, req._id),
  ]);
  assert.equal(
    [accept, cancel].filter((r) => r.status === "fulfilled").length,
    1,
    "the request is answered once"
  );

  const row = await FriendRequest.findById(req._id).lean();
  const friends = await friendService.listFriends(a._id);
  if (accept.status === "fulfilled") {
    assert.equal(row.status, "accepted");
    assert.equal(friends.length, 1);
  } else {
    assert.equal(row.status, "cancelled");
    assert.equal(friends.length, 0, "a cancelled request never became a friendship");
  }
});

guarded("a rejected sender has to wait before asking again", async () => {
  const [a, b] = await Promise.all([mkUser(), mkUser()]);
  const req = await friendService.sendFriendRequest(a._id, b._id);
  await friendService.rejectFriendRequest(b._id, req._id);

  // Otherwise send → reject → send is an unlimited push-notification cannon.
  await assert.rejects(
    () => friendService.sendFriendRequest(a._id, b._id),
    (e) => e.statusCode === 429
  );
  // The player who said no can still change their mind.
  const back = await friendService.sendFriendRequest(b._id, a._id);
  assert.equal(back.status, "pending");
});

guarded("open outgoing requests are capped", async () => {
  const me = await mkUser();
  const others = await Promise.all([mkUser(), mkUser(), mkUser(), mkUser()]);
  for (const other of others.slice(0, 3)) {
    await friendService.sendFriendRequest(me._id, other._id);
  }
  await assert.rejects(
    () => friendService.sendFriendRequest(me._id, others[3]._id),
    (e) => e.statusCode === 429
  );
});

guarded("malformed ids are a 404, not a server error", async () => {
  const a = await mkUser();
  for (const call of [
    () => friendService.sendFriendRequest(a._id, "not-an-id"),
    () => friendService.sendFriendRequest(a._id, undefined),
    () => friendService.acceptFriendRequest(a._id, "not-an-id"),
    () => friendService.rejectFriendRequest(a._id, "not-an-id"),
    () => friendService.cancelFriendRequest(a._id, "not-an-id"),
    () => friendService.removeFriend(a._id, "not-an-id"),
  ]) {
    await assert.rejects(call, (e) => e.statusCode === 404);
  }
});

guarded("a request from a deleted player cannot be accepted", async () => {
  const [gone, me] = await Promise.all([mkUser(), mkUser()]);
  const req = await friendService.sendFriendRequest(gone._id, me._id);
  await User.deleteOne({ _id: gone._id });

  const list = await friendService.listPendingRequests(me._id);
  assert.equal(list.incoming.length, 0, "no nameless tile offering a ghost");
  await assert.rejects(
    () => friendService.acceptFriendRequest(me._id, req._id),
    (e) => e.statusCode === 404
  );
  assert.equal((await friendService.listFriends(me._id)).length, 0);
  assert.notEqual((await FriendRequest.findById(req._id).lean()).status, "pending");
});

guarded("every request path tells both players in real time", async () => {
  const events = [];
  friendService.setSocialIo({
    to: (room) => ({ emit: (event, payload) => events.push({ room, event, payload }) }),
  });
  try {
    const [a, b] = await Promise.all([mkUser(), mkUser()]);
    const roomA = `user:${a._id}`;
    const roomB = `user:${b._id}`;
    const got = (room, event) => events.some((e) => e.room === room && e.event === event);

    // The REST routes are what the app calls; they used to emit nothing.
    const req = await friendService.sendFriendRequest(a._id, b._id);
    assert.ok(got(roomB, "friend:request"), "recipient hears about the request");
    const heard = events.find((e) => e.room === roomB && e.event === "friend:request");
    assert.equal(heard.payload.requestId, String(req._id));

    events.length = 0;
    await friendService.acceptFriendRequest(b._id, req._id);
    assert.ok(got(roomA, "friend:added") && got(roomB, "friend:added"));

    events.length = 0;
    await friendService.removeFriend(a._id, b._id);
    assert.ok(got(roomA, "friend:removed") && got(roomB, "friend:removed"));
  } finally {
    friendService.setSocialIo(null);
  }
});

guarded("duplicate open requests from before the index are folded on boot", async () => {
  const coll = FriendRequest.collection;
  await coll.dropIndex("one_pending_per_direction");
  const [a, b] = await Promise.all([mkUser(), mkUser()]);
  const first = await FriendRequest.create({ from: a._id, to: b._id, status: "pending" });
  await FriendRequest.create({ from: a._id, to: b._id, status: "pending" });

  delete require.cache[require.resolve("../services/friendSchemaService")];
  await require("../services/friendSchemaService").ensureFriendshipIndexes();

  const open = await FriendRequest.find({ from: a._id, to: b._id, status: "pending" }).lean();
  assert.equal(open.length, 1);
  assert.equal(String(open[0]._id), String(first._id), "the oldest one survives");
  const names = (await coll.indexes()).map((i) => i.name);
  assert.ok(names.includes("one_pending_per_direction"), "the index could build");
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
