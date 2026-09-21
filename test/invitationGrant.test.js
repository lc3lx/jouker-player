"use strict";

/**
 * An invitation is an admission grant, whatever the table's privacy.
 *
 * The grant used to be written only when `isPrivate`, because its only job was
 * getting past the privacy gate. It now also decides who may stand at a *full*
 * table waiting for a seat — so on a public table an invitation would have
 * been refused at the door, which is the main thing invitations are for.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Table = require("../models/tableModel");
const User = require("../models/userModel");
const {
  canStandAtTable,
  openSeatCount,
  tableGrant,
} = require("../services/tableAdmissionService");

let mongo = null;
const savedEnv = {};
let invitationService = null;
let friendService = null;
let realIsBlocked = null;
let realGetRelationship = null;

let seq = 9300;
async function makeTable({ seated = 0, capacity = 4, isPrivate = false, owner = null } = {}) {
  return Table.create({
    gameType: "poker",
    tier: "beginner",
    tableNumber: seq++,
    smallBlind: 10,
    bigBlind: 20,
    minBuyIn: 1000,
    maxBuyIn: 2000,
    capacity,
    status: "playing",
    isPrivate,
    owner,
    seats: Array.from({ length: seated }, (_, i) => ({
      user: new mongoose.Types.ObjectId(),
      chips: 1000,
      seatPosition: i,
    })),
  });
}

async function makeUser(name) {
  const id = new mongoose.Types.ObjectId();
  await User.create({ _id: id, name, email: `${id}@test.io`, password: "secret123" });
  return id;
}

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI"]) savedEnv[k] = process.env[k];
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(mongo.getUri(), { dbName: "invitation_grant_test" });

  invitationService = require("../services/invitationService");
  friendService = require("../services/friendService");
  // The invite path checks the block list and friendship; neither is what is
  // under test here, and both need real social records to satisfy.
  realIsBlocked = friendService.isBlocked;
  realGetRelationship = friendService.getRelationship;
  friendService.isBlocked = async () => false;
  friendService.getRelationship = async () => ({ isFriend: true });
});

test.after(async () => {
  if (friendService && realIsBlocked) {
    friendService.isBlocked = realIsBlocked;
    friendService.getRelationship = realGetRelationship;
  }
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (mongo) await mongo.stop();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("inviting someone to a public table admits them to it", async () => {
  // This is the case that used to write no grant at all.
  const host = await makeUser("Host");
  const guest = await makeUser("Guest");
  const t = await makeTable({ seated: 4, capacity: 4, isPrivate: false });

  await invitationService.sendInvitation(host, {
    toUserId: String(guest),
    gameType: "poker",
    tableId: String(t._id),
  });

  const after = await Table.findById(t._id).lean();
  assert.ok(
    tableGrant(after, guest).invited,
    "the invitation wrote no grant, so the guest is a stranger at the door"
  );
});

test("the invited guest may then wait at that full public table", async () => {
  // End to end: the invite is what turns a refusal into a seat in waiting.
  const host = await makeUser("Host2");
  const guest = await makeUser("Guest2");
  const stranger = await makeUser("Stranger2");
  const t = await makeTable({ seated: 4, capacity: 4, isPrivate: false });

  const stand = (table, uid) =>
    canStandAtTable({
      table,
      userId: uid,
      hasOpenSeat: openSeatCount(table, table.capacity) > 0,
    });

  const before = await Table.findById(t._id).lean();
  assert.equal(stand(before, guest), false, "admitted before being invited");

  await invitationService.sendInvitation(host, {
    toUserId: String(guest),
    gameType: "poker",
    tableId: String(t._id),
  });

  const after = await Table.findById(t._id).lean();
  assert.equal(stand(after, guest), true, "the invited guest was turned away");
  assert.equal(stand(after, stranger), false, "the invite admitted everyone");
});

test("a private table still gets its grant, as it always did", async () => {
  const host = await makeUser("Host3");
  const guest = await makeUser("Guest3");
  const t = await makeTable({ seated: 2, capacity: 4, isPrivate: true, owner: host });

  await invitationService.sendInvitation(host, {
    toUserId: String(guest),
    gameType: "poker",
    tableId: String(t._id),
  });

  const after = await Table.findById(t._id).lean();
  assert.ok(tableGrant(after, guest).invited);
});

test("inviting the same player twice does not double the grant", async () => {
  const host = await makeUser("Host4");
  const guest = await makeUser("Guest4");
  const t = await makeTable({ seated: 1, capacity: 4 });

  for (let i = 0; i < 2; i += 1) {
    await invitationService.sendInvitation(host, {
      toUserId: String(guest),
      gameType: "poker",
      tableId: String(t._id),
    }).catch(() => {});
  }

  const after = await Table.findById(t._id).lean();
  const mine = (after.allowedUsers || []).filter((u) => String(u) === String(guest));
  assert.equal(mine.length, 1, "allowedUsers grows without bound on repeat invites");
});

test("an invitation with no table touches no table", async () => {
  const host = await makeUser("Host5");
  const guest = await makeUser("Guest5");
  const t = await makeTable({ seated: 0, capacity: 4 });

  await invitationService.sendInvitation(host, {
    toUserId: String(guest),
    gameType: "poker",
  });

  const after = await Table.findById(t._id).lean();
  assert.deepEqual(after.allowedUsers || [], []);
});

console.log("invitationGrant.test.js: all tests registered");
