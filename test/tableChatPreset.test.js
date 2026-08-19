"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const TableChatPreset = require("../models/tableChatPresetModel");
const InteractionItem = require("../models/interactionItemModel");

test("chat preset defaults have unique keys and both kinds", () => {
  const rows = TableChatPreset.DEFAULT_PRESETS;
  const keys = rows.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(rows.some((p) => p.kind === "emoji"));
  const welcome = rows.find((p) => p.key === "phrase_welcome");
  assert.equal(welcome.textAr, "مرحباً بالجميع");
});

test("default catalog includes sticker category that flies to a target", () => {
  const stickers = InteractionItem.DEFAULT_ITEMS.filter((i) => i.category === "sticker");
  assert.ok(stickers.length >= 10);
  assert.ok(stickers.every((i) => i.animation === "sticker_fly"));
});
