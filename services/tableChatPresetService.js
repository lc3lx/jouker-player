"use strict";

const TableChatPreset = require("../models/tableChatPresetModel");

function publicRow(doc) {
  const d = doc.toObject ? doc.toObject() : doc;
  return {
    key: d.key,
    kind: d.kind,
    icon: d.icon || null,
    textAr: d.textAr || null,
    textEn: d.textEn || null,
    vipOnly: !!d.vipOnly,
    enabled: d.enabled !== false,
    sortOrder: d.sortOrder || 0,
  };
}

async function listPublished() {
  await TableChatPreset.ensureDefaults();
  const rows = await TableChatPreset.find({ enabled: true })
    .sort({ kind: 1, sortOrder: 1, key: 1 })
    .lean();
  const emojis = rows.filter((r) => r.kind === "emoji").map(publicRow);
  const phrases = rows.filter((r) => r.kind === "phrase").map(publicRow);
  return { emojis, phrases };
}

async function listAdmin({ kind } = {}) {
  await TableChatPreset.ensureDefaults();
  const filter = {};
  if (kind === "emoji" || kind === "phrase") filter.kind = kind;
  const rows = await TableChatPreset.find(filter)
    .sort({ kind: 1, sortOrder: 1, key: 1 })
    .lean();
  return rows.map(publicRow);
}

function normalizeKey(raw, kind) {
  const key = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!key) throw new Error("KEY_REQUIRED");
  if (!/^[a-z0-9_]+$/.test(key)) throw new Error("INVALID_KEY");
  if (kind === "phrase" && !key.startsWith("phrase_")) {
    return `phrase_${key}`;
  }
  if (kind === "emoji" && !key.startsWith("emoji_")) {
    return `emoji_${key}`;
  }
  return key;
}

function invalidateChatCache() {
  try {
    require("../sockets/tableChat").invalidatePresetCache();
  } catch (_) {
    /* tableChat may not be loaded in some unit tests */
  }
}

async function create(data = {}) {
  const kind = data.kind === "emoji" ? "emoji" : "phrase";
  const key = normalizeKey(data.key, kind);
  const existing = await TableChatPreset.findOne({ key }).lean();
  if (existing) throw new Error("KEY_EXISTS");
  const doc = await TableChatPreset.create({
    key,
    kind,
    icon: kind === "emoji" ? String(data.icon || data.textAr || "").trim() || "😀" : (data.icon || "💬"),
    textAr: String(data.textAr || data.icon || "").trim() || null,
    textEn: String(data.textEn || "").trim() || null,
    vipOnly: data.vipOnly === true,
    enabled: data.enabled !== false,
    sortOrder: Number.isFinite(Number(data.sortOrder)) ? Number(data.sortOrder) : 0,
  });
  invalidateChatCache();
  return publicRow(doc);
}

async function update(key, data = {}) {
  const doc = await TableChatPreset.findOne({ key: String(key) });
  if (!doc) throw new Error("NOT_FOUND");
  if (data.icon !== undefined) doc.icon = String(data.icon || "").trim() || doc.icon;
  if (data.textAr !== undefined) doc.textAr = String(data.textAr || "").trim() || null;
  if (data.textEn !== undefined) doc.textEn = String(data.textEn || "").trim() || null;
  if (data.vipOnly !== undefined) doc.vipOnly = data.vipOnly === true;
  if (data.enabled !== undefined) doc.enabled = data.enabled !== false;
  if (data.sortOrder !== undefined) doc.sortOrder = Number(data.sortOrder) || 0;
  await doc.save();
  invalidateChatCache();
  return publicRow(doc);
}

async function setEnabled(key, enabled) {
  return update(key, { enabled: !!enabled });
}

async function remove(key) {
  const r = await TableChatPreset.deleteOne({ key: String(key) });
  if (!r.deletedCount) throw new Error("NOT_FOUND");
  invalidateChatCache();
  return { deleted: true, key: String(key) };
}

module.exports = {
  listPublished,
  listAdmin,
  create,
  update,
  setEnabled,
  remove,
  publicRow,
};
