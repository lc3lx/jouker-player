"use strict";

/** UTC calendar day as YYYY-MM-DD — single source for active-day tracking. */
function utcDayStr(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

module.exports = { utcDayStr };
