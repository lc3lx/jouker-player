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
 * May this user stand at the table without a seat?
 *
 * Being unseated at a table is not a way of watching it — it is how a player
 * picks their chair. `spectatorMode` on the client means "arrive without a
 * seat" (`poker_service._subscribeAndStart`), and every poker player passes
 * through it on the way to sitting down.
 *
 * So there are exactly two reasons to be standing here:
 *
 *   1. **A seat is open and you came to take it.** This is the normal join.
 *   2. **The table is full and the host invited you.** You wait, and take the
 *      next seat that frees.
 *
 * Anything else is watching, which is what this gate now refuses. The old rule
 * allowed any public table outright, so anyone who sent `watch_table` received
 * the delayed feed indefinitely with no obligation to ever sit.
 *
 * Standing still only ever grants the *delayed* feed
 * (`spectatorDelayService`) — never live cards. That matters more now, not
 * less: an invited guest may legitimately stand at a table for a long time,
 * and the delay is what stops that becoming a channel to a seated partner.
 *
 * @param {object} args.table
 * @param {string} args.userId
 * @param {boolean} args.hasOpenSeat whether a seat is free to be taken now
 */
function canStandAtTable({ table, userId, hasOpenSeat = false }) {
  if (!table) return false;

  const { admitted } = tableGrant(table, userId);

  // An explicit grant is what the privacy flag exists to protect, so it
  // outranks both switches — including a host who turned spectators off but
  // then invited someone to come and play. It is also the only thing that
  // permits standing at a table with no seat to take.
  if (admitted) return true;

  if (table.isPrivate) return false;

  // `settings.allowSpectators` is deliberately not consulted any more. It said
  // "nobody may watch my table", and that is now true of every table — while
  // as a gate here it would also have blocked a stranger from *joining* one,
  // since taking a seat runs through this same door.

  // Public, uninvited: allowed only on the way to a chair.
  return hasOpenSeat === true;
}

/** Seats taken vs. capacity. Bots are not in `table.seats`, so this counts people. */
function openSeatCount(table, capacity) {
  const cap = Number(capacity ?? table?.capacity) || 0;
  const taken = Array.isArray(table?.seats) ? table.seats.length : 0;
  return Math.max(0, cap - taken);
}

/**
 * @deprecated Use {@link canStandAtTable}, which also needs to know whether a
 * seat is free. Kept so a caller that has not been updated fails closed on a
 * full public table rather than silently going on admitting watchers.
 */
function canWatchTable(table, userId) {
  return canStandAtTable({
    table,
    userId,
    hasOpenSeat: openSeatCount(table) > 0,
  });
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
  canStandAtTable,
  openSeatCount,
  canWatchTable,
  canJoinPrivateTable,
};
