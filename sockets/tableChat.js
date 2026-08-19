"use strict";

/**
 * Shared in-table chat helpers used by every card-game namespace
 * (poker `/table-game`, and trix / tarneeb41 on `/game`).
 *
 * The socket layer is the authority for *who* may post: a client can only
 * emit into a room it already joined (which only happens after seat/spectator
 * verification). This module only handles sanitisation, light rate limiting
 * and building the normalised broadcast payload so all games behave the same.
 */

const MAX_BODY = 200;
const MAX_NAME = 40;

// Small curated set of quick reactions the client can fire without typing.
const QUICK_EMOJIS = [
  "👍",
  "👎",
  "😂",
  "😍",
  "😎",
  "😢",
  "😡",
  "🔥",
  "💰",
  "🃏",
  "👏",
  "🎉",
  "🤔",
  "😱",
  "🙏",
  "❤️",
];
const EMOJI_SET = new Set(QUICK_EMOJIS);

/** Extra allowlist + phrase map loaded from TableChatPreset (admin CMS). */
let extraEmojis = new Set();
let phraseMap = new Map();
let presetCacheAt = 0;
const PRESET_CACHE_MS = 15000;

function invalidatePresetCache() {
  presetCacheAt = 0;
}

function injectPresetCacheForTests({ emojis, phrases } = {}) {
  extraEmojis = new Set(emojis || []);
  phraseMap = new Map(Object.entries(phrases || {}));
  presetCacheAt = Date.now();
}

async function refreshPresetCache(force = false) {
  if (!force && Date.now() - presetCacheAt < PRESET_CACHE_MS && presetCacheAt > 0) {
    return;
  }
  try {
    const svc = require("../services/tableChatPresetService");
    const { emojis, phrases } = await svc.listPublished();
    extraEmojis = new Set(
      (emojis || []).map((e) => e.icon).filter((icon) => typeof icon === "string" && icon)
    );
    phraseMap = new Map(
      (phrases || []).map((p) => [p.key, p.textAr || p.textEn]).filter(([, t]) => t)
    );
    presetCacheAt = Date.now();
  } catch (_) {
    if (presetCacheAt === 0) presetCacheAt = Date.now();
  }
}

// Per-user sliding window: max messages inside the window.
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 6;
const _buckets = new Map(); // userId -> number[] (timestamps)

function checkRate(userId) {
  const key = String(userId);
  const now = Date.now();
  const arr = (_buckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    const retryAfterMs = RATE_WINDOW_MS - (now - arr[0]);
    _buckets.set(key, arr);
    return { ok: false, retryAfterMs: Math.max(250, retryAfterMs) };
  }
  arr.push(now);
  _buckets.set(key, arr);
  return { ok: true };
}

function sanitizeBody(raw) {
  if (typeof raw !== "string") return "";
  // Drop control chars (keep normal whitespace), collapse runs of whitespace.
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, MAX_BODY);
}

function sanitizeName(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, MAX_NAME);
}

function sanitizeAvatar(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  if (v.length > 512) return null;
  // Only allow http(s) urls or bare relative asset paths.
  if (/^https?:\/\//i.test(v) || /^[\w\-./]+$/.test(v)) return v;
  return null;
}

function sanitizeEmoji(raw) {
  if (typeof raw !== "string") return null;
  return EMOJI_SET.has(raw) || extraEmojis.has(raw) ? raw : null;
}

/**
 * Resolve free-text / emoji / admin phraseKey into the fields buildChatMessage
 * expects. Phrase keys never go on the wire as raw keys — only the published text.
 */
async function resolveChatInput({ body, emoji, phraseKey }) {
  const key = typeof phraseKey === "string" ? phraseKey.trim() : "";
  if (key) {
    await refreshPresetCache();
    const text = phraseMap.get(key);
    // #region agent log
    try {
      fetch("http://127.0.0.1:7937/ingest/b9a00eef-7143-4edb-b1d5-038072464bf7", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "b181d7",
        },
        body: JSON.stringify({
          sessionId: "b181d7",
          runId: "emoji-hud",
          hypothesisId: "H2",
          location: "tableChat.js:resolveChatInput",
          message: "phraseKey resolved",
          data: { phraseKey: key, hit: Boolean(text), phraseCount: phraseMap.size },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
    } catch (_) {
      /* ignore */
    }
    // #endregion
    if (!text) return { ok: false, reason: "unknown_phrase" };
    return { ok: true, body: sanitizeBody(text), emoji: null };
  }
  if (emoji) await refreshPresetCache();
  return { ok: true, body: sanitizeBody(body), emoji: sanitizeEmoji(emoji) };
}

/**
 * Build a normalised chat message payload.
 * Returns `{ ok: true, message }` or `{ ok: false, reason }`.
 */
function buildChatMessage({ userId, name, avatar, body, emoji }) {
  const cleanBody = sanitizeBody(body);
  const cleanEmoji = sanitizeEmoji(emoji);
  if (!cleanBody && !cleanEmoji) {
    return { ok: false, reason: "empty_message" };
  }
  const message = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    userId: String(userId),
    name: sanitizeName(name) || "Player",
    avatar: sanitizeAvatar(avatar),
    body: cleanBody || null,
    emoji: cleanEmoji,
    ts: Date.now(),
  };
  return { ok: true, message };
}

module.exports = {
  MAX_BODY,
  QUICK_EMOJIS,
  checkRate,
  sanitizeBody,
  sanitizeName,
  sanitizeAvatar,
  sanitizeEmoji,
  buildChatMessage,
  resolveChatInput,
  invalidatePresetCache,
  injectPresetCacheForTests,
  refreshPresetCache,
};
