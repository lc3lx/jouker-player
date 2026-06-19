/**
 * ParkourRoom — lifecycle wrapper syncing in-memory ParkourGame with Mongo ParkourRace.
 */
const ParkourRace = require("../../models/parkourRaceModel");
const logger = require("../../utils/logger");

class ParkourRoom {
  constructor(game, persistFn) {
    this.game = game;
    this.persistFn = persistFn || defaultPersist;
    this.timers = [];
  }

  async persist(extra = {}) {
    return this.persistFn(this.game, extra);
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  schedule(fn, ms) {
    const t = setTimeout(() => {
      fn().catch((err) => logger.error("parkour_room_timer_error", { reason: err?.message }));
    }, ms);
    this.timers.push(t);
    return t;
  }
}

async function defaultPersist(game, extra = {}) {
  const update = {
    state: game.state,
    sessionId: game.sessionId,
    participants: game.toMongoParticipants(),
    countdownStartedAt: game.countdownStartedAt ? new Date(game.countdownStartedAt) : null,
    raceStartedAt: game.raceStartedAt ? new Date(game.raceStartedAt) : null,
    finishedCount: game.finishedCount,
    nextFinishOrder: game.nextFinishOrder,
    eventNonces: game.getEventNonces(),
    ...extra,
  };
  if (game.state === "finished" && !extra.raceEndedAt) {
    update.raceEndedAt = new Date();
  }
  await ParkourRace.findOneAndUpdate({ raceId: game.raceId }, { $set: update });
}

module.exports = { ParkourRoom, defaultPersist };
