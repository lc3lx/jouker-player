"use strict";

const { publish } = require("../events/domainEventBus");
const Events = require("../events/eventTypes");

function publishSpinCompleted(userId, { sourceId = "", game = "", won = false } = {}) {
  if (!userId) return;
  publish(Events.PLAYER_COMPLETED_SPIN, {
    userId: String(userId),
    sourceId: sourceId ? String(sourceId) : "",
    game: game || "",
    won: won === true,
  });
}

module.exports = {
  publishSpinCompleted,
};
