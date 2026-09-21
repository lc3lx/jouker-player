"use strict";

/**
 * Who may stand at a table without a seat.
 *
 * Being unseated at a table is not a way of watching it — it is how a poker
 * player picks a chair (`spectatorMode` on the client means "arrive without a
 * seat"). So the gate cannot simply refuse everyone, or nobody could ever sit
 * down. It has to separate the two reasons someone is standing there:
 *
 *   - a seat is open and they came to take it, or
 *   - the table is full and the host invited them, so they wait for one.
 *
 * Everything else is watching, and watching is what this removes. The old rule
 * admitted any public table outright, so anyone who sent `watch_table` got the
 * delayed feed forever with no obligation to ever sit.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canStandAtTable,
  openSeatCount,
  canWatchTable,
  tableGrant,
} = require("../services/tableAdmissionService");

const OWNER = "5f000000000000000000000a";
const GUEST = "5f000000000000000000000b";
const STRANGER = "5f000000000000000000000c";

/** `seats` holds people; engine bots are not written to it. */
function table({
  capacity = 6,
  seated = 0,
  isPrivate = false,
  owner = null,
  allowedUsers = [],
  allowSpectators = true,
} = {}) {
  return {
    capacity,
    seats: Array.from({ length: seated }, (_, i) => ({ user: `seat-${i}` })),
    isPrivate,
    owner,
    allowedUsers,
    settings: { allowSpectators },
  };
}

const stand = (t, userId) =>
  canStandAtTable({
    table: t,
    userId,
    hasOpenSeat: openSeatCount(t, t.capacity) > 0,
  });

// ── the way in ────────────────────────────────────────────────────────────

test("a free seat lets anyone in — this is how a chair gets picked", () => {
  // Refusing here would not remove watching, it would remove joining.
  const t = table({ capacity: 6, seated: 3 });
  assert.equal(stand(t, STRANGER), true);
});

test("a full public table turns a stranger away", () => {
  // The lobby sends them to another table at the same stake instead.
  const t = table({ capacity: 6, seated: 6 });
  assert.equal(stand(t, STRANGER), false);
});

// ── the one exception ─────────────────────────────────────────────────────

test("an invited guest may wait at a full table", () => {
  // The whole point: full, invited, and standing there until a seat frees.
  const t = table({ capacity: 6, seated: 6, allowedUsers: [GUEST] });
  assert.equal(stand(t, GUEST), true);
  assert.equal(stand(t, STRANGER), false, "the invite leaked to someone else");
});

test("the host may always stand at their own full table", () => {
  const t = table({ capacity: 6, seated: 6, isPrivate: true, owner: OWNER });
  assert.equal(stand(t, OWNER), true);
  assert.ok(tableGrant(t, OWNER).isOwner);
});

test("an invite outranks a host who switched spectators off", () => {
  // They turned watching off and then asked someone to come and play; the
  // later, more specific act wins.
  const t = table({
    capacity: 6,
    seated: 6,
    allowSpectators: false,
    allowedUsers: [GUEST],
  });
  assert.equal(stand(t, GUEST), true);
  assert.equal(stand(t, STRANGER), false);
});

// ── privacy is unchanged ──────────────────────────────────────────────────

test("a private table with a free seat is still closed to strangers", () => {
  // An open seat is a reason to admit the public, never a reason to ignore
  // privacy.
  const t = table({ capacity: 6, seated: 2, isPrivate: true, owner: OWNER });
  assert.equal(stand(t, STRANGER), false);
  assert.equal(stand(t, OWNER), true);
});

test("spectators-off no longer blocks someone coming to sit down", () => {
  // The switch meant "nobody may watch my table", which is now true of every
  // table anyway. As a gate here it would have blocked *joining* too, since
  // taking a seat runs through this same door.
  const open = table({ capacity: 6, seated: 2, allowSpectators: false });
  const full = table({ capacity: 6, seated: 6, allowSpectators: false });
  assert.equal(stand(open, STRANGER), true, "a stranger could not take a free seat");
  assert.equal(stand(full, STRANGER), false);
});

// ── it follows the table, not a snapshot ──────────────────────────────────

test("the answer changes the moment a seat frees", () => {
  // A stranger refused while the table was full must be able to walk in when
  // somebody stands up, without anything being restarted or re-read.
  const full = table({ capacity: 6, seated: 6 });
  assert.equal(stand(full, STRANGER), false);

  const afterLeaving = table({ capacity: 6, seated: 5 });
  assert.equal(stand(afterLeaving, STRANGER), true);
});

test("seats are counted against the table's own capacity", () => {
  assert.equal(openSeatCount(table({ capacity: 9, seated: 4 }), 9), 5);
  assert.equal(openSeatCount(table({ capacity: 5, seated: 5 }), 5), 0);
  // Never negative, however the seats and capacity disagree.
  assert.equal(openSeatCount(table({ capacity: 4, seated: 7 }), 4), 0);
});

test("a missing table admits nobody", () => {
  assert.equal(canStandAtTable({ table: null, userId: STRANGER, hasOpenSeat: true }), false);
});

// ── the old entry point ───────────────────────────────────────────────────

test("the deprecated gate fails closed rather than going on admitting watchers", () => {
  // Any caller not yet updated must not keep the open door alive.
  const full = table({ capacity: 6, seated: 6 });
  assert.equal(canWatchTable(full, STRANGER), false);
  assert.equal(canWatchTable(full, GUEST), false);

  const open = table({ capacity: 6, seated: 1 });
  assert.equal(canWatchTable(open, STRANGER), true);
});

console.log("tableWatchGate.test.js: all tests registered");
