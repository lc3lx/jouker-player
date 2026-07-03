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
  return EMOJI_SET.has(raw) ? raw : null;
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
};
