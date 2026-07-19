const mongoose = require("mongoose");
const ApiError = require("../utils/apiError");
const Cosmetic = require("../models/cosmeticModel");
const UserCosmetics = require("../models/userCosmeticsModel");
const { withMongoTransaction, ledgerWithdraw } = require("./walletLedgerService");
const equippedCache = require("../utils/cosmeticsEquippedCache");
const DEFAULT_CATALOG = require("../data/defaultCosmeticsCatalog");

/** slotKey → legacy equipped.{field} mirror target (write-through compat). */
const LEGACY_SLOT_FIELD = { avatar_frame: "avatarFrame", table_theme: "tableTheme", card_back: "cardSkin" };

/** Resolve the equip slot for an item (explicit slot → type map → type; bundle → null). */
function slotForItem(item) {
  if (!item) return null;
  if (item.slot) return item.slot;
  if (item.type === "bundle") return null;
  return Cosmetic.TYPE_TO_SLOT?.[item.type] ?? item.type ?? null;
}

/** Iterate equippedBySlot whether it's a Mongoose Map (doc) or plain object (lean). */
function entriesOf(bySlot) {
  if (!bySlot) return [];
  if (bySlot instanceof Map) return [...bySlot.entries()];
  return Object.entries(bySlot);
}

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
  const previewImageUrl = resolveAssetUrl(assetPath);
  // Animated variant (gif / lottie / rive) — admin URL wins, else resolve asset key.
  const animationUrl = doc.animationUrl
    ? String(doc.animationUrl).trim()
    : resolveAssetUrl(doc.animatedAssetKey);
  return {
    id: String(doc._id),
    type: doc.type,
    category: doc.category || doc.type,
    slot: doc.slot ?? slotForItem(doc),
    games: Array.isArray(doc.games) && doc.games.length ? doc.games : Cosmetic.defaultGamesForType(doc.type),
    name: doc.name,
    nameAr: doc.nameAr || null,
    assetKey: doc.assetKey,
    previewImage,
    previewImageUrl,
    renderType: doc.renderType || "png",
    animatedAssetKey: doc.animatedAssetKey || null,
    animationUrl: animationUrl || null,
    price: finalPrice,
    finalPrice,
    basePrice: base,
    currencyId: doc.currencyId || "coins",
    bundlePrice: doc.type === "bundle" ? finalPrice : undefined,
    rarity: doc.rarity || "common",
    vipLevelRequired: doc.vipLevelRequired || null,
    season: doc.season || null,
    limitedEdition: !!doc.limitedEdition,
    isActive: !!doc.isActive,
    status: doc.status || (doc.isActive === false ? "disabled" : "published"),
    promoMeta: doc.promoMeta || null,
    featured: !!(doc.featured || promoFeatured),
    featuredOrder: Number(doc.featuredOrder) || 0,
    sortOrder: Number(doc.sortOrder) || 0,
    purchaseCount: Math.floor(Number(doc.purchaseCount) || 0),
    equipCount: Math.floor(Number(doc.equipCount) || 0),
  };
}

/** Resolve a stored asset path (skin/, vip/, /assets/, http, or uploads filename) to a URL. */
function resolveAssetUrl(assetPath) {
  const p = assetPath ? String(assetPath).trim() : "";
  if (!p) return null;
  if (p.startsWith("skin/") || p.startsWith("vip/")) return `/assets/${p.replace(/^\/+/, "")}`;
  if (p.startsWith("/assets/") || p.startsWith("http")) return p;
  return `/uploads/cosmetics/${p}`;
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

// Cosmetics gated to a VIP level are granted, not sold — hidden from the store.
// `{ vipLevelRequired: null }` also matches docs where the field is absent (legacy).
const STORE_VISIBLE = { isActive: true, vipLevelRequired: null };

async function listCatalog() {
  await ensureDefaultCatalog();
  const rows = await Cosmetic.find(STORE_VISIBLE)
    .sort({ type: 1, rarity: 1, name: 1 })
    .lean();
  const pub = rows.map(publicCosmeticDisplay).filter(Boolean);
  return addBundleDerivedFields(pub, rows);
}

/** Dynamic store categories (enabled) — the store renders sections from these. */
async function listCategories() {
  const CosmeticCategory = require("../models/cosmeticCategoryModel");
  await CosmeticCategory.ensureDefaults();
  return CosmeticCategory.find({ enabled: true })
    .sort({ sortOrder: 1, key: 1 })
    .lean();
}

async function listFeatured(limit = 24) {
  await ensureDefaultCatalog();
  const rows = await Cosmetic.find({ ...STORE_VISIBLE, featured: true })
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
  const rows = await Cosmetic.find(STORE_VISIBLE).lean();
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
      equippedBySlot: new Map(),
      equipped: { tableTheme: null, cardSkin: null, avatarFrame: null },
    });
    await row.save(session ? { session } : {});
  }
  return row;
}

function payloadFromRowAndIdMap(row, idTo) {
  // Data-driven: resolve every equipped slot to its asset key.
  const bySlot = {};
  for (const [slot, cid] of entriesOf(row.equippedBySlot)) {
    if (!cid) continue;
    const c = idTo.get(String(cid));
    if (c) bySlot[slot] = c.assetKey;
  }
  // Legacy fallback for rows created before the equippedBySlot migration.
  const legacyPairs = [
    ["tableTheme", "table_theme"],
    ["cardSkin", "card_back"],
    ["avatarFrame", "avatar_frame"],
  ];
  for (const [field, slot] of legacyPairs) {
    if (!bySlot[slot] && row.equipped?.[field]) {
      const c = idTo.get(String(row.equipped[field]));
      if (c) bySlot[slot] = c.assetKey;
    }
  }
  const tableTheme = bySlot.table_theme || null;
  const cardSkin = bySlot.card_back || null;
  const avatarFrame = bySlot.avatar_frame || null;
  // `skin` is the public alias for equipped avatar_frame (country skins).
  return { tableTheme, cardSkin, avatarFrame, skin: avatarFrame, bySlot };
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
        bySlot: p.bySlot ?? {},
      });
    } else {
      missing.push(uid);
    }
  }
  if (missing.length === 0) return out;

  const objectIds = missing.map((s) => toObjectId(s)).filter(Boolean);
  if (objectIds.length === 0) {
    for (const uid of missing) {
      const empty = { tableTheme: null, cardSkin: null, avatarFrame: null, skin: null, bySlot: {} };
      await equippedCache.set(uid, empty);
      out.set(uid, empty);
    }
    return out;
  }

  const rows = await UserCosmetics.find({ user: { $in: objectIds } }).lean();
  const found = new Set(rows.map((r) => String(r.user)));

  const cosmeticIds = new Set();
  for (const r of rows) {
    for (const [, cid] of entriesOf(r.equippedBySlot)) if (cid) cosmeticIds.add(String(cid));
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
      const empty = { tableTheme: null, cardSkin: null, avatarFrame: null, skin: null, bySlot: {} };
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
      equipped: { tableTheme: null, cardSkin: null, avatarFrame: null, skin: null, bySlot: {} },
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

/**
 * Owned inventory grouped by category + equipped cosmetics with full render
 * details (for the profile popup's Inventory / Inspect / Preview sections).
 * Two queries total, reused inside the single profile endpoint.
 */
async function getProfileCosmetics(userId) {
  const row = await UserCosmetics.findOne({ user: userId }).lean();
  if (!row) return { ownedByCategory: {}, equippedDetailed: {}, ownedCount: 0 };

  const ownedIds = (row.ownedItems || []).map(String);
  const bySlot = row.equippedBySlot || {};
  const equippedIds = Object.values(bySlot).map(String).filter(Boolean);
  const legacy = row.equipped || {};
  for (const f of ["tableTheme", "cardSkin", "avatarFrame"]) {
    if (legacy[f]) equippedIds.push(String(legacy[f]));
  }
  const allIds = [...new Set([...ownedIds, ...equippedIds])].map(toObjectId).filter(Boolean);
  const docs = allIds.length ? await Cosmetic.find({ _id: { $in: allIds } }).lean() : [];
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  const ownedByCategory = {};
  for (const id of ownedIds) {
    const d = byId.get(id);
    if (!d) continue;
    const pub = publicCosmeticDisplay(d);
    const cat = pub.category || pub.type || "other";
    (ownedByCategory[cat] ||= []).push(pub);
  }

  const equippedDetailed = {};
  for (const [slot, id] of Object.entries(bySlot)) {
    const d = byId.get(String(id));
    if (d) equippedDetailed[slot] = publicCosmeticDisplay(d);
  }

  return { ownedByCategory, equippedDetailed, ownedCount: ownedIds.length };
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
  if (!(row.equippedBySlot instanceof Map)) row.equippedBySlot = new Map();

  const slot = slotForItem(item);
  if (!slot) throw new ApiError("Invalid cosmetic type", 400);

  // Idempotent: already equipped in this slot → no-op.
  if (String(row.equippedBySlot.get(slot) || "") === String(cosmeticId)) {
    invalidateEquippedCache(userId);
    return getMe(userId);
  }

  // Data-driven equip + write-through legacy mirror.
  row.equippedBySlot.set(slot, cosmeticId);
  const legacyField = LEGACY_SLOT_FIELD[slot];
  if (legacyField) row.equipped[legacyField] = cosmeticId;

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

  if (item.type !== "bundle") {
    if (slotForItem(item)) {
      try {
        await equipCosmetic(userId, cosmeticIdRaw);
      } catch (_) {
        /* not owned race / duplicate */
      }
    }
    return;
  }

  // Bundle: equip the first granted cosmetic in each distinct slot.
  const grantIds = resolveBundleGrantIds(item);
  const docs =
    grantIds.length === 0
      ? []
      : await Cosmetic.find({ _id: { $in: grantIds }, isActive: true }).lean();
  const seenSlots = new Set();
  for (const d of docs) {
    const slot = slotForItem(d);
    if (!slot || seenSlots.has(slot)) continue;
    seenSlots.add(slot);
    try {
      await equipCosmetic(userId, String(d._id));
    } catch (_) {}
  }
}

/** Attach server-truth cosmetics to a public table_state payload (seats[].cosmetics). */
async function mergeCosmeticsIntoPublicState(state) {
  if (!state || !Array.isArray(state.seats)) return state;
  const {
    resolvePublicCosmeticsForPokerSeats,
    emptyCosmetics,
    publicSeatCosmeticsPayload,
  } = require("./playerPublicCosmeticsService");
  const { byUserId, activeTableTheme, activeTableAsset } =
    await resolvePublicCosmeticsForPokerSeats(state.seats);
  state.activeTableTheme = activeTableTheme;
  state.activeTableAsset = activeTableAsset;
  for (const s of state.seats) {
    const pack = byUserId.get(String(s.userId));
    s.vipLevel = pack?.vipLevel || null;
    s.cosmetics =
      publicSeatCosmeticsPayload(pack?.cosmetics) || emptyCosmetics();
  }
  return state;
}

module.exports = {
  listCatalog,
  listCategories,
  listFeatured,
  listRecommended,
  getMe,
  getProfileCosmetics,
  buyCosmetic,
  equipCosmetic,
  autoEquipAfterBuy,
  resolveEquippedPayloadForUsers,
  mergeCosmeticsIntoPublicState,
  publicCosmeticDisplay,
  invalidateEquippedCache,
  invalidateEquippedCacheMany,
};
