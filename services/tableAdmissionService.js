"use strict";

/**
 * Who is allowed into a private table, and on what grounds.
 *
 * A VIP table is always private — `vipTableService.createVipHandler` forces it
 * and generates a password nobody is meant to type, because the host admits
 * people by inviting them (`invitationService` writes the guest into
 * `allowedUsers`). Both the owner and an invited guest then enter the table as
 * spectators first, to pick a seat.
 *
 * That collided with two gates that predate the VIP flow, so the rules live
 * here as pure functions used by both, rather than as two conditions that can
 * drift apart again.
 */

function _id(value) {
  return value == null ? "" : String(value);
}

/**
 * Has the host explicitly admitted this user — as the owner, or by invite?
 *
 * This is the "explicit viewer-grant model" the watch gate's own comment said
 * it was waiting for. It already existed; nothing was reading it.
 */
function tableGrant(table, userId) {
  const uid = _id(userId);
  const isOwner = uid !== "" && _id(table?.owner) === uid;
  const invited =
    uid !== "" &&
    (table?.allowedUsers || []).some((user) => _id(user) === uid);
  return { isOwner, invited, admitted: isOwner || invited };
}

/**
 * May this user open a spectator view of the table?
 *
 * The old rule was `isPrivate || allowSpectators === false → deny`, with no
 * exception for the owner or an invited guest. Since seat picking runs through
 * the spectator view, that denied the host their own VIP table and denied every
 * guest they invited: the client showed "تعذر الاتصال بالطاولة" and there was
 * no way through it.
 *
 * A grant still admits only to the *delayed* spectator feed
 * (`spectatorDelayService`), which is the same stream any watcher gets.
 */
function canWatchTable(table, userId) {
  if (!table) return false;
  // An explicit grant is what the privacy flag exists to protect, so it
  // outranks both switches — including a host who turned spectators off but
  // then invited someone to come and play.
  if (tableGrant(table, userId).admitted) return true;
  if (table.isPrivate) return false;
  if (table.settings && table.settings.allowSpectators === false) return false;
  return true;
}

/**
 * May this user take a seat at a private table?
 *
 * The gate used to read:
 *
 *   let passwordOk = invitationGranted || isOwner;
 *   if (password && table.password) passwordOk = await bcrypt.compare(…);
 *
 * — the compare *overwrote* the grant. An invited guest whose client happened
 * to send a password (a stale field, a remembered value, anything non-empty)
 * had their invitation thrown away and was told "Invalid table password". A
 * grant is not a weaker form of the password; it is an independent reason to
 * be let in.
 */
function canJoinPrivateTable({ table, userId, passwordMatches = false }) {
  if (!table) return false;
  if (!table.isPrivate) return true;
  return tableGrant(table, userId).admitted || passwordMatches === true;
}

module.exports = {
  tableGrant,
  canWatchTable,
  canJoinPrivateTable,
};
