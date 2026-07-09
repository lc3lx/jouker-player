"use strict";

const { publish } = require("../events/domainEventBus");
const Events = require("../events/eventTypes");

function publishSpinCompleted(userId, { sourceId = "", game = "" } = {}) {
  if (!userId) return;
  publish(Events.PLAYER_COMPLETED_SPIN, {
    userId: String(userId),
    sourceId: sourceId ? String(sourceId) : "",
    game: game || "",
  });
}

module.exports = {
  publishSpinCompleted,
};
