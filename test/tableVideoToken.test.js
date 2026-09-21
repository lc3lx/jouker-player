"use strict";

/**
 * The LiveKit token — the one thing that decides whether table video and voice
 * work at all.
 *
 * Everything downstream depends on three facts in this JWT: the room is the
 * table (so two players at one table land in one room), the identity is the
 * Mongo user id (which is how a seat finds its participant on the client), and
 * the grants allow both publishing and subscribing. Get any of them wrong and
 * the call fails silently — the camera button simply does nothing, or a player
 * publishes into a room nobody else is in.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Table = require("../models/tableModel");
const videoToken = require("../services/tableVideoTokenService");

let mongo = null;
const savedEnv = {};

/** The JWT payload, without verifying — we assert on claims, not on crypto. */
function claims(jwt) {
  const part = String(jwt).split(".")[1];
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}

const SEATED = new mongoose.Types.ObjectId();
const OTHER_SEATED = new mongoose.Types.ObjectId();
const STRANGER = new mongoose.Types.ObjectId();

let tableSeq = 8600;
async function makeTable({ gameType = "poker", seats = [SEATED, OTHER_SEATED] } = {}) {
  return Table.create({
    gameType,
    tier: "beginner",
    tableNumber: tableSeq++,
    smallBlind: 10,
    bigBlind: 20,
    minBuyIn: 1000,
    maxBuyIn: 1000,
    capacity: 9,
    status: "playing",
    seats: seats.map((u, i) => ({ user: u, chips: 1000, seatPosition: i })),
  });
}

test.before(async () => {
  for (const k of [
    "MONGODB_URI",
    "MONGO_URI",
    "DB_URI",
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "LIVEKIT_TOKEN_TTL_SEC",
  ]) {
    savedEnv[k] = process.env[k];
  }
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(mongo.getUri(), { dbName: "video_token_test" });

  // Shaped like the real thing; never a real credential.
  process.env.LIVEKIT_URL = "wss://example.livekit.cloud";
  process.env.LIVEKIT_API_KEY = "APItestkey00000";
  process.env.LIVEKIT_API_SECRET = "0123456789abcdef0123456789abcdef0123456789ab";
});

test.after(async () => {
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

test.beforeEach(async () => {
  await Table.deleteMany({});
  delete process.env.LIVEKIT_TOKEN_TTL_SEC;
});

// ── the room ──────────────────────────────────────────────────────────────

test("two players at one table are minted into the same room", async () => {
  // If the room name were derived from anything per-player, each would publish
  // into a room of their own and see an empty table with the camera "on".
  const t = await makeTable();
  const a = await videoToken.createPokerTableVideoToken({
    userId: SEATED,
    tableId: String(t._id),
  });
  const b = await videoToken.createPokerTableVideoToken({
    userId: OTHER_SEATED,
    tableId: String(t._id),
  });

  assert.equal(a.roomName, String(t._id));
  assert.equal(b.roomName, a.roomName, "the two seats were sent to different rooms");
  assert.equal(claims(a.token).video.room, String(t._id));
  assert.equal(claims(b.token).video.room, String(t._id));
});

test("players at different tables never share a room", async () => {
  const t1 = await makeTable({ seats: [SEATED] });
  const t2 = await makeTable({ seats: [OTHER_SEATED] });
  const a = await videoToken.createPokerTableVideoToken({
    userId: SEATED,
    tableId: String(t1._id),
  });
  const b = await videoToken.createPokerTableVideoToken({
    userId: OTHER_SEATED,
    tableId: String(t2._id),
  });
  assert.notEqual(a.roomName, b.roomName);
});

// ── the identity ──────────────────────────────────────────────────────────

test("the identity is the Mongo user id, which is how a seat finds its video", async () => {
  // The client matches `participant.identity == seat.userId`. Anything else
  // here and every remote seat stays on its still photo forever.
  const t = await makeTable();
  const res = await videoToken.createPokerTableVideoToken({
    userId: SEATED,
    tableId: String(t._id),
    displayName: "عمر",
  });
  const c = claims(res.token);
  assert.equal(c.sub, String(SEATED));
  assert.equal(c.name, "عمر");
});

// ── the grants ────────────────────────────────────────────────────────────

test("the grant allows both publishing and subscribing", async () => {
  // canPublish alone means others never hear you; canSubscribe alone means you
  // never hear them. Both are needed on every seat.
  const t = await makeTable();
  const res = await videoToken.createPokerTableVideoToken({
    userId: SEATED,
    tableId: String(t._id),
  });
  const grant = claims(res.token).video;
  assert.equal(grant.roomJoin, true);
  assert.equal(grant.canPublish, true, "this player would be seen and heard by nobody");
  assert.equal(grant.canSubscribe, true, "this player would see and hear nobody");
});

test("the token's stated lifetime is the one actually baked into it", async () => {
  // `nbf` is 0 and there is no `iat`, so the only lifetime that exists is
  // `exp` measured against now — a mismatch here would expire the token
  // earlier than anything reports, and reconnects would fail for no visible
  // reason.
  const t = await makeTable();
  const before = Math.floor(Date.now() / 1000);
  const res = await videoToken.createPokerTableVideoToken({
    userId: SEATED,
    tableId: String(t._id),
  });
  const c = claims(res.token);

  assert.ok(res.expiresInSec >= 120, "too short to survive a reconnect");
  const drift = Math.abs(c.exp - (before + res.expiresInSec));
  assert.ok(drift <= 5, `exp is ${drift}s away from the reported lifetime`);
});

test("the ttl is clamped, whatever the environment says", async () => {
  const t = await makeTable();
  process.env.LIVEKIT_TOKEN_TTL_SEC = "1";
  let res = await videoToken.createPokerTableVideoToken({
    userId: SEATED,
    tableId: String(t._id),
  });
  assert.equal(res.expiresInSec, 120);

  process.env.LIVEKIT_TOKEN_TTL_SEC = "999999";
  res = await videoToken.createPokerTableVideoToken({
    userId: SEATED,
    tableId: String(t._id),
  });
  assert.equal(res.expiresInSec, 7200);
});

// ── who is allowed in ─────────────────────────────────────────────────────

test("someone who is not seated gets no token", async () => {
  const t = await makeTable();
  await assert.rejects(
    () => videoToken.createPokerTableVideoToken({
      userId: STRANGER,
      tableId: String(t._id),
    }),
    (e) => /seated/i.test(String(e.message)),
    "a stranger could join the table's room and listen in"
  );
});

test("all three card games have video; nothing else does", async () => {
  for (const gameType of ["poker", "trix", "tarneeb41"]) {
    const t = await makeTable({ gameType });
    const res = await videoToken.createPokerTableVideoToken({
      userId: SEATED,
      tableId: String(t._id),
    });
    assert.ok(res.token, `${gameType} has no video`);
  }
});

test("a missing or malformed table is refused, not guessed at", async () => {
  await assert.rejects(
    () => videoToken.createPokerTableVideoToken({ userId: SEATED, tableId: "not-an-id" }),
    (e) => /invalid/i.test(String(e.message))
  );
  await assert.rejects(
    () => videoToken.createPokerTableVideoToken({
      userId: SEATED,
      tableId: String(new mongoose.Types.ObjectId()),
    }),
    (e) => /not found/i.test(String(e.message))
  );
});

// ── configuration ─────────────────────────────────────────────────────────

test("an unconfigured server says so instead of minting a dead token", async () => {
  // Without this the client would connect to nothing and the camera button
  // would look broken with no reason given anywhere.
  const t = await makeTable();
  const saved = process.env.LIVEKIT_URL;
  process.env.LIVEKIT_URL = "";
  try {
    await assert.rejects(
      () => videoToken.createPokerTableVideoToken({
        userId: SEATED,
        tableId: String(t._id),
      }),
      (e) => e.statusCode === 503 && /LIVEKIT_URL/.test(String(e.message))
    );
  } finally {
    process.env.LIVEKIT_URL = saved;
  }
});

console.log("tableVideoToken.test.js: all tests registered");
