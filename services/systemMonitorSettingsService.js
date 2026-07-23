/**
 * Live-tunable settings for the system health monitor. Cached in memory
 * (refreshed at boot + on every admin update), same _settings/applySettings/
 * getSettings shape as tableLifecycleSettingsService/botBehaviorService.
 */
let _settings = {
  enabled: true,
  sweepIntervalMs: 60000,
  walletLockOrphanGraceMs: 5 * 60 * 1000,
  stuckHandGraceMs: 2 * 60 * 1000,
  tournamentMatchGraceMs: 5 * 60 * 1000,
  repeatedAnomalyThreshold: 3,
  memoryWarningPct: 75,
  memoryCriticalPct: 90,
  eventLoopLagWarningMs: 100,
  eventLoopLagCriticalMs: 500,
  autoRepairEnabled: true,
};

function applySettings(s) {
  if (!s) return;
  _settings = {
    enabled: s.enabled ?? _settings.enabled,
    sweepIntervalMs: s.sweepIntervalMs ?? _settings.sweepIntervalMs,
    walletLockOrphanGraceMs: s.walletLockOrphanGraceMs ?? _settings.walletLockOrphanGraceMs,
    stuckHandGraceMs: s.stuckHandGraceMs ?? _settings.stuckHandGraceMs,
    tournamentMatchGraceMs: s.tournamentMatchGraceMs ?? _settings.tournamentMatchGraceMs,
    repeatedAnomalyThreshold: s.repeatedAnomalyThreshold ?? _settings.repeatedAnomalyThreshold,
    memoryWarningPct: s.memoryWarningPct ?? _settings.memoryWarningPct,
    memoryCriticalPct: s.memoryCriticalPct ?? _settings.memoryCriticalPct,
    eventLoopLagWarningMs: s.eventLoopLagWarningMs ?? _settings.eventLoopLagWarningMs,
    eventLoopLagCriticalMs: s.eventLoopLagCriticalMs ?? _settings.eventLoopLagCriticalMs,
    autoRepairEnabled: s.autoRepairEnabled ?? _settings.autoRepairEnabled,
  };
}

function getSettings() {
  return _settings;
}

async function loadFromDb() {
  const SystemMonitorSettings = require("../models/systemMonitorSettingsModel");
  const doc = await SystemMonitorSettings.getDefaults();
  applySettings(doc.toObject ? doc.toObject() : doc);
  return _settings;
}

module.exports = {
  applySettings,
  getSettings,
  loadFromDb,
};
