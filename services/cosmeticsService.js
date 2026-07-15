const mongoose = require("mongoose");
const ApiError = require("../utils/apiError");
const Cosmetic = require("../models/cosmeticModel");
const UserCosmetics = require("../models/userCosmeticsModel");
const { withMongoTransaction, ledgerWithdraw } = require("./walletLedgerService");
const equippedCache = require("../utils/cosmeticsEquippedCache");
const DEFAULT_CATALOG = require("../data/defaultCosmeticsCatalog");

function toObjectId(id) {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

function invalidateEquippedCache(userId) {
  if (userId == null) return;
  void equippedCache.del(String(userId));
}

function invalidateEquippedCacheMany(userIds) {
  for (const u of userIds || []) void equippedCache.del(String(u));
}

/** Safe folder/asset id for client packs (no path segments or weird chars). */
function assertSanitizedAssetKey(assetKey) {
  const k = String(assetKey || "").trim();
  if (k.length < 1 || k.length > 64) {
    throw new ApiError("Invalid cosmetic asset key", 400);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(k)) {
    throw new ApiError("Invalid cosmetic asset key", 400);
  }
}

function effectivePrice(doc) {
  const base = Math.floor(Number(doc?.price) || 0);
  const meta = doc?.promoMeta || {};
  const expRaw = meta.expiresAt;
  if (expRaw) {
    const exp = new Date(expRaw).getTime();
    if (Number.isFinite(exp) && Date.now() > exp) return base;
  }
  const pct = Math.min(100, Math.max(0, Number(meta.discountPercent) || 0));
  return Math.max(0, Math.floor((base * (100 - pct)) / 100));
}

/** Bundle grant ids: prefer `promoMeta.items`, fallback `bundleGrants`. */
function resolveBundleGrantIds(doc) {
  const m = doc?.promoMeta || {};
  const raw = m.items || m.bundleGrants || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => toObjectId(x)).filter(Boolean);
}

function publicCosmeticDisplay(doc) {
  if (!doc) return null;
  const base = Math.floor(Number(doc.price) || 0);
  const finalPrice = effectivePrice(doc);
  const promoFeatured = (doc.promoMeta || {}).featured === true || (doc.promoMeta || {}).featured === "true";
  const previewImage = doc.previewImage ? String(doc.previewImage).trim() : null;
  const skinFile =
    doc.promoMeta && doc.promoMeta.skinFile
      ? String(doc.promoMeta.skinFile).trim()
      : null;
  const assetPath = skinFile || previewImage;
  let previewImageUrl = null;
  if (assetPath) {
    if (assetPath.startsWith("skin/") || assetPath.startsWith("vip/")) {
      previewImageUrl = `/assets/${assetPath.replace(/^\/+/, "")}`;
    } else if (assetPath.startsWith("/assets/") || assetPath.startsWith("http")) {
      previewImageUrl = assetPath;
    } else {
      previewImageUrl = `/uploads/cosmetics/${assetPath}`;
    }
  }
  return {
    id: String(doc._id),
    type: doc.type,
    name: doc.name,
    assetKey: doc.assetKey,
    previewImage,
    previewImageUrl,
    price: finalPrice,
    finalPrice,
    basePrice: base,
    bundlePrice: doc.type === "bundle" ? finalPrice : undefined,
    rarity: doc.rarity || "common",
    isActive: !!doc.isActive,
    promoMeta: doc.promoMeta || null,
    featured: !!(doc.featured || promoFeatured),
    featuredOrder: Number(doc.featuredOrder) || 0,
    purchaseCount: Math.floor(Number(doc.purchaseCount) || 0),
    equipCount: Math.floor(Number(doc.equipCount) || 0),
  };
}

async function addBundleDerivedFields(publicList, leanRows) {
  const byId = new Map(leanRows.map((r) => [String(r._id), r]));
  const allGrantIds = new Set();
  for (const r of leanRows) {
    if (r.type === "bundle") {
      for (const id of resolveBundleGrantIds(r)) allGrantIds.add(String(id));
    }
  }
  if (allGrantIds.size === 0) return publicList;

  const grantDocs = await Cosmetic.find({
    _id: { $in: [...allGrantIds].map((x) => toObjectId(x)).filter(Boolean) },
    isActive: true,
  })
    .select("price promoMeta")
    .lean();
  const effPriceById = new Map(
    grantDocs.map((g) => [String(g._id), effectivePrice(g)]),
  );

  return publicList.map((pub) => {
    const row = byId.get(pub.id);
    if (!row || row.type !== "bundle") return pub;
    const ids = resolveBundleGrantIds(row).map(String);
    let retail = 0;
    for (const gid of ids) retail += effPriceById.get(gid) ?? 0;
    const final = pub.finalPrice ?? pub.price;
    const savingsPct =
      retail > 0 && retail > final ? Math.round(((retail - final) / retail) * 100) : 0;
    return {
      ...pub,
      bundleItemIds: ids,
      bundleRetailTotal: retail,
      bundleSavingsPercent: savingsPct,
    };
  });
}

async function ensureDefaultCatalog() {
  const count = await Cosmetic.countDocuments({ isActive: true });
  if (count === 0) {
    for (const row of DEFAULT_CATALOG) {
      await Cosmetic.updateOne(
        { type: row.type, assetKey: row.assetKey },
        { $setOnInsert: row },
        { upsert: true }
      );
    }

    const midnight = await Cosmetic.findOne({
      type: "table_theme",
      assetKey: "midnight_royal",
    }).select("_id");
    const ruby = await Cosmetic.findOne({ type: "card_skin", assetKey: "ruby" }).select("_id");
    if (midnight && ruby) {
      await Cosmetic.updateOne(
        { type: "bundle", assetKey: "starter_mogul_pack" },
        {
          $set: {
            type: "bundle",
            name: "باقة المبتدئ المميزة",
            assetKey: "starter_mogul_pack",
            price: 3200,
            rarity: "rare",
            isActive: true,
            featured: true,
            featuredOrder: 0,
            promoMeta: { items: [midnight._id, ruby._id] },
          },
        },
        { upsert: true }
      );
    }
  }

  // Country skins: upsert when missing even if the catalog already has items.
  for (const row of DEFAULT_CATALOG) {
    if (row.type !== "avatar_frame") continue;
    if (!String(row.assetKey || "").startsWith("skin_")) continue;
    await Cosmetic.updateOne(
      { type: row.type, assetKey: row.assetKey },
      { $setOnInsert: row },
      { upsert: true }
    );
  }
}

async function listCatalog() {
  await ensureDefaultCatalog();
  const rows = await Cosmetic.find({ isActive: true })
    .sort({ type: 1, rarity: 1, name: 1 })
    .lean();
  const pub = rows.map(publicCosmeticDisplay).filter(Boolean);
  return addBundleDerivedFields(pub, rows);
}

async function listFeatured(limit = 24) {
  await ensureDefaultCatalog();
  const rows = await Cosmetic.find({ isActive: true, featured: true })
    .sort({ featuredOrder: 1, name: 1 })
    .limit(limit)
    .lean();
  const pub = rows.map(publicCosmeticDisplay).filter(Boolean);
  return addBundleDerivedFields(pub, rows);
}

async function listRecommended(userId, limit = 16) {
  await ensureDefaultCatalog();
  const row = await UserCosmetics.findOne({ user: userId }).lean();
  const owned = new Set((row?.ownedItems || []).map((x) => String(x)));
  const rows = await Cosmetic.find({ isActive: true }).lean();
  const rarityW = { epic: 100, rare: 50, common: 10 };
  const scored = rows
    .filter((r) => !owned.has(String(r._id)))
    .map((r) => {
      const pop = (Number(r.purchaseCount) || 0) + (Number(r.equipCount) || 0);
      const score = (rarityW[r.rarity] || 5) + Math.log10(10 + pop) * 22;
      return { r, score };
    });
  scored.sort((a, b) => b.score - a.score);
  const topLean = scored.slice(0, limit).map((x) => x.r);
  const pub = topLean.map(publicCosmeticDisplay).filter(Boolean);
  return addBundleDerivedFields(pub, topLean);
}

async function getOrCreateUserRow(userId, session) {
  let row = session
    ? await UserCosmetics.findOne({ user: userId }).session(session)
    : await UserCosmetics.findOne({ user: userId });
  if (!row) {
    row = new UserCosmetics({
      user: userId,
      ownedItems: [],
      equipped: { tableTheme: null, cardSkin: null, avatarFrame: null },
    });
    await row.save(session ? { session } : {});
  }
  return row;
}

function payloadFromRowAndIdMap(row, idTo) {
  let tableTheme = null;
  let cardSkin = null;
  let avatarFrame = null;
  if (row.equipped?.tableTheme) {
    const c = idTo.get(String(row.equipped.tableTheme));
    if (c && c.type === "table_theme") tableTheme = c.assetKey;
  }
  if (row.equipped?.cardSkin) {
    const c = idTo.get(String(row.equipped.cardSkin));
    if (c && c.type === "card_skin") cardSkin = c.assetKey;
  }
  if (row.equipped?.avatarFrame) {
    const c = idTo.get(String(row.equipped.avatarFrame));
    if (c && c.type === "avatar_frame") avatarFrame = c.assetKey;
  }
  // `skin` is the public alias for equipped avatar_frame (country skins).
  return { tableTheme, cardSkin, avatarFrame, skin: avatarFrame };
}

/**
 * Map userId string -> { tableTheme, cardSkin, avatarFrame } asset keys
 * Redis-backed when configured, else memory; invalidated on buy/equip.
 */
async function resolveEquippedPayloadForUsers(userIds) {
  const ids = [...new Set((userIds || []).map((u) => String(u)).filter(Boolean))];
  const out = new Map();
  if (ids.length === 0) return out;

  const cachedPairs = await Promise.all(ids.map(async (uid) => ({ uid, p: await equippedCache.get(uid) })));
  const missing = [];
  for (const { uid, p } of cachedPairs) {
    if (p && typeof p === "object") {
      out.set(uid, {
        tableTheme: p.tableTheme ?? null,
        cardSkin: p.cardSkin ?? null,
        avatarFrame: p.avatarFrame ?? null,
        skin: p.skin ?? p.avatarFrame ?? null,
      });
    } else {
      missing.push(uid);
    }
  }
  if (missing.length === 0) return out;

  const objectIds = missing.map((s) => toObjectId(s)).filter(Boolean);
  if (objectIds.length === 0) {
    for (const uid of missing) {
      const empty = { tableTheme: null, cardSkin: null, avatarFrame: null, skin: null };
      await equippedCache.set(uid, empty);
      out.set(uid, empty);
    }
    return out;
  }

  const rows = await UserCosmetics.find({ user: { $in: objectIds } }).lean();
  const found = new Set(rows.map((r) => String(r.user)));

  const cosmeticIds = new Set();
  for (const r of rows) {
    if (r.equipped?.tableTheme) cosmeticIds.add(String(r.equipped.tableTheme));
    if (r.equipped?.cardSkin) cosmeticIds.add(String(r.equipped.cardSkin));
    if (r.equipped?.avatarFrame) cosmeticIds.add(String(r.equipped.avatarFrame));
  }
  const cDocs =
    cosmeticIds.size > 0
      ? await Cosmetic.find({
          _id: { $in: [...cosmeticIds].map((x) => toObjectId(x)).filter(Boolean) },
          isActive: true,
        })
          .select("assetKey type")
          .lean()
      : [];
  const idTo = new Map(cDocs.map((c) => [String(c._id), c]));

  for (const r of rows) {
    const uid = String(r.user);
    const payload = payloadFromRowAndIdMap(r, idTo);
    await equippedCache.set(uid, payload);
    out.set(uid, payload);
  }

  for (const oid of objectIds) {
    const uid = String(oid);
    if (!found.has(uid)) {
      const empty = { tableTheme: null, cardSkin: null, avatarFrame: null, skin: null };
      await equippedCache.set(uid, empty);
      out.set(uid, empty);
    }
  }

  return out;
}

async function getMe(userId) {
  const row = await UserCosmetics.findOne({ user: userId }).lean();
  if (!row) {
    return {
      owned: [],
      equipped: { tableTheme: null, cardSkin: null, avatarFrame: null },
      ownedIds: [],
    };
  }
  const ownedIds = row?.ownedItems?.length ? row.ownedItems.map(String) : [];
  const ownedDocs =
    ownedIds.length > 0
      ? await Cosmetic.find({ _id: { $in: ownedIds.map(toObjectId).filter(Boolean) } }).lean()
      : [];
  const owned = ownedDocs.map(publicCosmeticDisplay).filter(Boolean);

  let equipped = { tableTheme: null, cardSkin: null, avatarFrame: null };
  if (row?.equipped) {
    const payload = (await resolveEquippedPayloadForUsers([userId])).get(String(userId));
    if (payload) equipped = payload;
  }

  return {
    owned,
    equipped,
    // Full Mongo ids from user row (includes inactive / delisted cosmetics).
    ownedIds,
  };
}

async function buyCosmetic(userId, cosmeticIdRaw) {
  const cosmeticId = toObjectId(cosmeticIdRaw);
  if (!cosmeticId) throw new ApiError("Invalid cosmetic id", 400);

  await withMongoTransaction(async (session) => {
    const item = await Cosmetic.findOne({ _id: cosmeticId, isActive: true }).session(session);
    if (!item) throw new ApiError("Item not found", 404);
    assertSanitizedAssetKey(item.assetKey);

    const row = await getOrCreateUserRow(userId, session);
    const owned = new Set((row.ownedItems || []).map((x) => String(x)));

    if (item.type === "bundle") {
      const grantIds = resolveBundleGrantIds(item);
      if (grantIds.length === 0) throw new ApiError("Invalid bundle configuration", 400);

      const missingGrants = grantIds.filter((id) => !owned.has(String(id)));
      if (missingGrants.length === 0) throw new ApiError("Already owned", 400);

      const price = effectivePrice(item);
      if (price > 0) {
        await ledgerWithdraw({
          session,
          userId,
          amount: price,
          ledgerType: "cosmetic_purchase",
          meta: {
            cosmeticId: String(cosmeticId),
            assetKey: item.assetKey,
            type: "bundle",
            bundleGrants: missingGrants.map(String),
          },
        });
      }

      for (const gid of missingGrants) {
        row.ownedItems.push(gid);
        owned.add(String(gid));
      }
      await row.save({ session });
      await Cosmetic.updateOne({ _id: cosmeticId }, { $inc: { purchaseCount: 1 } }).session(
        session,
      );
      return;
    }

    if (owned.has(String(cosmeticId))) {
      throw new ApiError("Already owned", 400);
    }

    const price = effectivePrice(item);
    if (price > 0) {
      await ledgerWithdraw({
        session,
        userId,
        amount: price,
        ledgerType: "cosmetic_purchase",
        meta: {
          cosmeticId: String(cosmeticId),
          assetKey: item.assetKey,
          type: item.type,
        },
      });
    }

    row.ownedItems = [...(row.ownedItems || []), cosmeticId];
    await row.save({ session });
    await Cosmetic.updateOne({ _id: cosmeticId }, { $inc: { purchaseCount: 1 } }).session(session);
  });

  invalidateEquippedCache(userId);
  return getMe(userId);
}

async function equipCosmetic(userId, cosmeticIdRaw) {
  const cosmeticId = toObjectId(cosmeticIdRaw);
  if (!cosmeticId) throw new ApiError("Invalid cosmetic id", 400);

  const item = await Cosmetic.findOne({ _id: cosmeticId, isActive: true });
  if (!item) throw new ApiError("Item not found", 404);
  assertSanitizedAssetKey(item.assetKey);

  if (item.type === "bundle") {
    throw new ApiError("Cannot equip a bundle", 400);
  }

  const row = await getOrCreateUserRow(userId, null);
  const owned = new Set((row.ownedItems || []).map((x) => String(x)));
  if (!owned.has(String(cosmeticId))) {
    throw new ApiError("Not owned", 403);
  }

  row.equipped = row.equipped || {};

  if (item.type === "table_theme") {
    if (String(row.equipped.tableTheme || "") === String(cosmeticId)) {
      invalidateEquippedCache(userId);
      return getMe(userId);
    }
    row.equipped.tableTheme = cosmeticId;
  } else if (item.type === "card_skin") {
    if (String(row.equipped.cardSkin || "") === String(cosmeticId)) {
      invalidateEquippedCache(userId);
      return getMe(userId);
    }
    row.equipped.cardSkin = cosmeticId;
  } else if (item.type === "avatar_frame") {
    if (String(row.equipped.avatarFrame || "") === String(cosmeticId)) {
      invalidateEquippedCache(userId);
      return getMe(userId);
    }
    row.equipped.avatarFrame = cosmeticId;
  } else {
    throw new ApiError("Invalid cosmetic type", 400);
  }

  await row.save();
  invalidateEquippedCache(userId);
  await Cosmetic.updateOne({ _id: cosmeticId }, { $inc: { equipCount: 1 } });
  return getMe(userId);
}

/**
 * Equip newly purchased item(s): single cosmetic, or first table_theme + first card_skin from a bundle.
 */
async function autoEquipAfterBuy(userId, cosmeticIdRaw) {
  const cosmeticId = toObjectId(cosmeticIdRaw);
  if (!cosmeticId) return;
  const item = await Cosmetic.findOne({ _id: cosmeticId, isActive: true }).lean();
  if (!item) return;
  if (item.type === "table_theme" || item.type === "card_skin" || item.type === "avatar_frame") {
    try {
      await equipCosmetic(userId, cosmeticIdRaw);
    } catch (_) {
      /* not owned race / duplicate */
    }
    return;
  }
  if (item.type !== "bundle") return;

  const grantIds = resolveBundleGrantIds(item);
  const docs =
    grantIds.length === 0
      ? []
      : await Cosmetic.find({ _id: { $in: grantIds }, isActive: true }).lean();
  const themes = docs.filter((d) => d.type === "table_theme");
  const skins = docs.filter((d) => d.type === "card_skin");
  const frames = docs.filter((d) => d.type === "avatar_frame");
  if (themes[0]) {
    try {
      await equipCosmetic(userId, String(themes[0]._id));
    } catch (_) {}
  }
  if (skins[0]) {
    try {
      await equipCosmetic(userId, String(skins[0]._id));
    } catch (_) {}
  }
  if (frames[0]) {
    try {
      await equipCosmetic(userId, String(frames[0]._id));
    } catch (_) {}
  }
}

/** Attach server-truth cosmetics to a public table_state payload (seats[].cosmetics). */
async function mergeCosmeticsIntoPublicState(state) {
  if (!state || !Array.isArray(state.seats)) return state;
  const {
    resolvePublicCosmeticsForSeats,
    emptyCosmetics,
  } = require("./playerPublicCosmeticsService");
  const map = await resolvePublicCosmeticsForSeats(state.seats);
  for (const s of state.seats) {
    const pack = map.get(String(s.userId));
    s.vipLevel = pack?.vipLevel || null;
    s.cosmetics = pack?.cosmetics || emptyCosmetics();
  }
  return state;
}

module.exports = {
  listCatalog,
  listFeatured,
  listRecommended,
  getMe,
  buyCosmetic,
  equipCosmetic,
  autoEquipAfterBuy,
  resolveEquippedPayloadForUsers,
  mergeCosmeticsIntoPublicState,
  publicCosmeticDisplay,
  invalidateEquippedCache,
  invalidateEquippedCacheMany,
};
