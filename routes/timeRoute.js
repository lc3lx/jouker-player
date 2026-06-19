const express = require("express");
const { POKER_TIMINGS } = require("../utils/poker/timings");

const router = express.Router();

/**
 * NTP-style sync — client sends clientTs, receives serverTime for offset calculation.
 * GET /api/v1/time/sync?clientTs=1700000000000
 */
router.get("/sync", (req, res) => {
  const serverTime = Date.now();
  const clientTs = Number(req.query.clientTs || 0);
  const turnActionMs = POKER_TIMINGS.TURN_SECONDS * 1000;

  res.status(200).json({
    status: "success",
    data: {
      serverTime,
      clientTs: Number.isFinite(clientTs) && clientTs > 0 ? clientTs : null,
      turnSeconds: POKER_TIMINGS.TURN_SECONDS,
      turnActionMs,
      reconnectWindowMs: POKER_TIMINGS.RECONNECT_WINDOW_MS,
    },
  });
});

module.exports = router;
