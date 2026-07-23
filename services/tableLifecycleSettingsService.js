/**
 * Live-tunable table-lifecycle timing knobs. Cached in memory (refreshed
 * from TableLifecycleSettings on boot + on every admin update), env-derived
 * values baked into the schema remain the fallback. Never rewrites the
 * reconnect/vacate/GC logic itself — those call the getters here instead of
 * reading POKER_TIMINGS/env constants directly, exactly like
 * botBehaviorService's relationship to the bot decision code.
 */
const { POKER_TIMINGS } = require("../utils/poker/timings");

let _settings = {
  pokerReconnectWindowMs: POKER_TIMINGS.RECONNECT_WINDOW_MS,
  pokerVacateWindowMs: POKER_TIMINGS.VACATE_WINDOW_MS,
  pokerWaitForPlayersMs: POKER_TIMINGS.WAIT_FOR_PLAYERS_MS,
  tarneeb41VacateMs: Math.max(5000, parseInt(process.env.CARD_TABLE_VACATE_MS || "60000", 10)),
  trixVacateMs: Math.max(
    5000,
    parseInt(process.env.TRIX_VACATE_MS || process.env.CARD_TABLE_VACATE_MS || "30000", 10)
  ),
  cardIdleTimeoutMs: Math.max(60000, parseInt(process.env.TABLE_IDLE_TIMEOUT_MS || "900000", 10)),
  cardGcIntervalMs: Math.max(30000, parseInt(process.env.TABLE_GC_INTERVAL_MS || "60000", 10)),
  pokerEmptyGcMs: Math.max(60000, parseInt(process.env.POKER_EMPTY_TABLE_GC_MS || "300000", 10)),
  pokerGcIntervalMs: Math.max(30000, parseInt(process.env.POKER_GC_INTERVAL_MS || "60000", 10)),
};

function applySettings(s) {
  if (!s) return;
  _settings = {
    pokerReconnectWindowMs: s.pokerReconnectWindowMs ?? _settings.pokerReconnectWindowMs,
    pokerVacateWindowMs: s.pokerVacateWindowMs ?? _settings.pokerVacateWindowMs,
    pokerWaitForPlayersMs: s.pokerWaitForPlayersMs ?? _settings.pokerWaitForPlayersMs,
    tarneeb41VacateMs: s.tarneeb41VacateMs ?? _settings.tarneeb41VacateMs,
    trixVacateMs: s.trixVacateMs ?? _settings.trixVacateMs,
    cardIdleTimeoutMs: s.cardIdleTimeoutMs ?? _settings.cardIdleTimeoutMs,
    cardGcIntervalMs: s.cardGcIntervalMs ?? _settings.cardGcIntervalMs,
    pokerEmptyGcMs: s.pokerEmptyGcMs ?? _settings.pokerEmptyGcMs,
    pokerGcIntervalMs: s.pokerGcIntervalMs ?? _settings.pokerGcIntervalMs,
  };
}

function getSettings() {
  return _settings;
}

async function loadFromDb() {
  const TableLifecycleSettings = require("../models/tableLifecycleSettingsModel");
  const doc = await TableLifecycleSettings.getDefaults();
  applySettings(doc.toObject ? doc.toObject() : doc);
  return _settings;
}

module.exports = {
  applySettings,
  getSettings,
  loadFromDb,
};
