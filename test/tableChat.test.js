"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const tableChat = require("../sockets/tableChat");

test("buildChatMessage accepts text", () => {
  const r = tableChat.buildChatMessage({
    userId: "u1",
    name: "Alice",
    body: "  hello world  ",
  });
  assert.equal(r.ok, true);
  assert.equal(r.message.body, "hello world");
  assert.equal(r.message.userId, "u1");
  assert.equal(r.message.name, "Alice");
});

test("buildChatMessage accepts curated emoji", () => {
  const r = tableChat.buildChatMessage({
    userId: "u1",
    name: "Bob",
    emoji: "🔥",
  });
  assert.equal(r.ok, true);
  assert.equal(r.message.emoji, "🔥");
  assert.equal(r.message.body, null);
});

test("buildChatMessage rejects unknown emoji", () => {
  const r = tableChat.buildChatMessage({
    userId: "u1",
    name: "Bob",
    emoji: "💩",
  });
  assert.equal(r.ok, false);
});

test("resolveChatInput maps admin phraseKey to published text", async () => {
  tableChat.injectPresetCacheForTests({
    phrases: { phrase_welcome: "مرحباً بالجميع" },
  });
  const r = await tableChat.resolveChatInput({ phraseKey: "phrase_welcome" });
  assert.equal(r.ok, true);
  assert.equal(r.body, "مرحباً بالجميع");
  assert.equal(r.emoji, null);
});

test("resolveChatInput rejects unknown phraseKey", async () => {
  tableChat.injectPresetCacheForTests({ phrases: {} });
  const r = await tableChat.resolveChatInput({ phraseKey: "nope" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown_phrase");
});

test("sanitizeEmoji accepts admin-injected extra emoji", () => {
  tableChat.injectPresetCacheForTests({ emojis: ["🫡"] });
  assert.equal(tableChat.sanitizeEmoji("🫡"), "🫡");
});

test("buildChatMessage rejects empty payload", () => {
  const r = tableChat.buildChatMessage({ userId: "u1", name: "X", body: "   " });
  assert.equal(r.ok, false);
});

test("checkRate limits burst traffic", () => {
  const uid = `rate-test-${Date.now()}`;
  for (let i = 0; i < tableChat.QUICK_EMOJIS.length; i++) {
    const r = tableChat.checkRate(uid);
    if (i < 6) assert.equal(r.ok, true);
  }
  const blocked = tableChat.checkRate(uid);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0);
});

test("sanitizeBody strips control chars and caps length", () => {
  const long = "a".repeat(300);
  const out = tableChat.sanitizeBody(`\x00hello\x1F\n${long}`);
  assert.ok(out.length <= tableChat.MAX_BODY);
  assert.ok(!out.includes("\x00"));
});
