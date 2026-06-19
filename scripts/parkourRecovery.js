/**
 * Cron-style parkour recovery — restore races and pending settlements.
 * Invoked on server startup from game.handlers; can also run standalone.
 */
const parkourRoomManager = require("../games/parkour/parkourRoomManager");
const { recoverParkourSettlements, ensureDefaultTrack } = require("../services/parkourService");
const logger = require("../utils/logger");

async function runParkourRecovery() {
  await ensureDefaultTrack();
  const restored = await parkourRoomManager.restoreActiveRaces();
  const settlements = await recoverParkourSettlements();
  logger.info("parkour_recovery_complete", { restored, settlements });
  return { restored, settlements };
}

if (require.main === module) {
  const dbConnection = require("../config/database");
  dbConnection()
    .then(() => runParkourRecovery())
    .then((r) => {
      console.log(JSON.stringify(r));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runParkourRecovery };
