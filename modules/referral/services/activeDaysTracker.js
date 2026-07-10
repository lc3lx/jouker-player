"use strict";

const { utcDayStr } = require("../../../utils/utcDay");
const ReferralInviteeSnapshot = require("../models/referralInviteeSnapshotModel");

/**
 * Returns Mongo update fragments for incrementing activeDays at most once per UTC day.
 * @param {string|null|undefined} lastActiveDayUtc
 */
function activeDayUpdate(lastActiveDayUtc) {
  const today = utcDayStr();
  if (lastActiveDayUtc === today) {
    return { inc: {}, set: {} };
  }
  return {
    inc: { activeDays: 1 },
    set: { lastActiveDayUtc: today },
  };
}

async function fetchLastActiveDayUtc(referrerId, inviteeId) {
  const row = await ReferralInviteeSnapshot.findOne({ referrerId, inviteeId })
    .select("lastActiveDayUtc")
    .lean();
  return row?.lastActiveDayUtc || null;
}

module.exports = {
  activeDayUpdate,
  fetchLastActiveDayUtc,
  utcDayStr,
};
