const DEFAULT_PREFERENCES = {
  language: "ar",
  notifications: true,
  soundEffects: true,
  twoFactorEnabled: false,
  hideProfile: false,
  loginAlerts: true,
};

function normalizePreferences(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const lang = String(src.language || DEFAULT_PREFERENCES.language).toLowerCase();
  return {
    language: lang === "en" ? "en" : "ar",
    notifications: src.notifications !== false && src.notifications !== "false",
    soundEffects: src.soundEffects !== false && src.soundEffects !== "false",
    twoFactorEnabled: src.twoFactorEnabled === true || src.twoFactorEnabled === "true",
    hideProfile: src.hideProfile === true || src.hideProfile === "true",
    loginAlerts: src.loginAlerts !== false && src.loginAlerts !== "false",
  };
}

function publicSettings(user) {
  const prefs = normalizePreferences(user?.preferences);
  return {
    ...prefs,
    email: user?.email || null,
    sessionVersion: Math.floor(Number(user?.sessionVersion) || 0),
  };
}

module.exports = {
  DEFAULT_PREFERENCES,
  normalizePreferences,
  publicSettings,
};
