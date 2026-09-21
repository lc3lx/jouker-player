/**
 * Getting into a private table.
 *
 * Reported as: "شتغلت الطاولة دعيت رفيقي لما فات عطتو الطاولة تعذر الاتصال
 * بالطاولة" — the host's VIP table worked, the invited friend was refused at
 * the door.
 *
 * A VIP table is always private, and both the host and their guests reach a
 * seat *through the spectator view*. The watch gate denied every private table
 * outright, with a comment saying it was waiting for an explicit viewer-grant
 * model — while `owner` and `allowedUsers`, written by the invite flow, sat
 * unread right there on the document.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  tableGrant,
  canWatchTable,
  canJoinPrivateTable,
} = require("../services/tableAdmissionService");

const HOST = "6650000000000000000000a1";
const GUEST = "6650000000000000000000b2";
const STRANGER = "6650000000000000000000c3";

/** A VIP table as `createVipHandler` makes it: private, owned, spectators on. */
function vipTable(overrides = {}) {
  return {
    isPrivate: true,
    owner: HOST,
    allowedUsers: [GUEST],
    settings: { allowSpectators: true },
    ...overrides,
  };
}

// ── the grant ─────────────────────────────────────────────────────────────

test("the owner and the invited guest are admitted; nobody else is", () => {
  const t = vipTable();
  assert.equal(tableGrant(t, HOST).isOwner, true);
  assert.equal(tableGrant(t, GUEST).invited, true);
  assert.equal(tableGrant(t, STRANGER).admitted, false);
});

test("a missing user id is never a grant", () => {
  // `String(undefined) === String(undefined)` would otherwise admit everyone
  // on a table with no owner.
  const t = vipTable({ owner: null, allowedUsers: [] });
  assert.equal(tableGrant(t, null).admitted, false);
  assert.equal(tableGrant(t, undefined).admitted, false);
  assert.equal(tableGrant(t, "").admitted, false);
});

test("ids compare across ObjectId and string", () => {
  const t = vipTable({ owner: { toString: () => HOST } });
  assert.equal(tableGrant(t, HOST).isOwner, true);
});

// ── watching ──────────────────────────────────────────────────────────────

test("the host can watch their own VIP table", () => {
  // Fails on the old gate, which denied on `isPrivate` alone.
  assert.equal(canWatchTable(vipTable(), HOST), true);
});

test("an invited guest can watch the table they were invited to", () => {
  // This is the reported bug.
  assert.equal(canWatchTable(vipTable(), GUEST), true);
});

test("a stranger still cannot watch a private table", () => {
  assert.equal(canWatchTable(vipTable(), STRANGER), false);
});

test("a grant outranks the host's own spectators-off switch", () => {
  // The guest was invited to play, not to spectate; the switch is for the
  // public, and the seat is reached through this view.
  const t = vipTable({ settings: { allowSpectators: false } });
  assert.equal(canWatchTable(t, GUEST), true);
  assert.equal(canWatchTable(t, HOST), true);
  assert.equal(canWatchTable(t, STRANGER), false);
});

test("a public table with spectators off is closed to strangers", () => {
  const t = { isPrivate: false, settings: { allowSpectators: false } };
  assert.equal(canWatchTable(t, STRANGER), false);
});

test("an ordinary public table is joinable while it has a seat", () => {
  // It used to be *watchable*: any public table admitted anyone who asked,
  // with no obligation to ever sit. Standing there is now only the walk to a
  // chair, so it lasts exactly as long as there is a chair to walk to.
  const withRoom = { isPrivate: false, settings: {}, capacity: 6, seats: [] };
  assert.equal(canWatchTable(withRoom, STRANGER), true);

  const full = {
    isPrivate: false,
    settings: {},
    capacity: 2,
    seats: [{ user: "a" }, { user: "b" }],
  };
  assert.equal(canWatchTable(full, STRANGER), false);
});

test("a missing table admits nobody", () => {
  assert.equal(canWatchTable(null, HOST), false);
});

// ── joining ───────────────────────────────────────────────────────────────

test("an invitation admits without any password", () => {
  assert.equal(
    canJoinPrivateTable({ table: vipTable(), userId: GUEST }),
    true
  );
});

test("an invitation survives a wrong password from the client", () => {
  // The old gate assigned the compare result over the grant, so any password
  // the client happened to send erased the invitation.
  assert.equal(
    canJoinPrivateTable({
      table: vipTable(),
      userId: GUEST,
      passwordMatches: false,
    }),
    true
  );
});

test("the owner is admitted the same way", () => {
  assert.equal(
    canJoinPrivateTable({ table: vipTable(), userId: HOST, passwordMatches: false }),
    true
  );
});

test("a correct password still admits someone with no invitation", () => {
  assert.equal(
    canJoinPrivateTable({
      table: vipTable(),
      userId: STRANGER,
      passwordMatches: true,
    }),
    true
  );
});

test("a stranger with no password and no invitation is refused", () => {
  assert.equal(
    canJoinPrivateTable({ table: vipTable(), userId: STRANGER }),
    false
  );
});

test("a public table needs neither", () => {
  assert.equal(
    canJoinPrivateTable({ table: { isPrivate: false }, userId: STRANGER }),
    true
  );
});

console.log("tableAdmission.test.js: all tests registered");
