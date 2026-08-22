"use strict";

const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const ArenaTournament = require("../models/arenaTournamentModel");
const ArenaTournamentSettings = require("../models/arenaTournamentSettingsModel");
const Table = require("../models/tableModel");
const catalog = require("./arenaTournamentCatalog");
const engine = require("./arenaTournamentEngineService");
const { logEvent } = require("./auditService");

function toInt(v) {
  return Math.floor(Number(v) || 0);
}

function actorMeta(req) {
  return {
    actor: req.user?._id || null,
    ip: req.ip,
    userAgent: req.get?.("user-agent"),
  };
}

function playerCount(t) {
  return Array.isArray(t.participants) ? t.participants.length : 0;
}

async function isRunningWithPlayers(t) {
  if (!t || t.lifecycle !== "running") return false;
  if ((t.participants || []).some((p) => p.tableId)) return true;
  const ids = t.tableIds || [];
  if (!ids.length) return false;
  const tables = await Table.find({ _id: { $in: ids } }).select("seats").lean();
  return tables.some((tb) => (tb.seats || []).length > 0);
}

async function assertNotLive(t) {
  if (await isRunningWithPlayers(t)) {
    throw new ApiError("لا يمكن التحكم ببطولة شغّالة وفيها لاعبين", 409);
  }
}

function serializeAdmin(t, flags = {}) {
  const base = engine.serializeTournament(t);
  return {
    ...base,
    adminEdited: !!t.adminEdited,
    cancelReason: t.cancelReason || null,
    ...flags,
  };
}

function flagsFor(t, live) {
  const registering = t.lifecycle === "registering";
  const running = t.lifecycle === "running";
  return {
    runningWithPlayers: live,
    canEditName: !live && (registering || running),
    canEditFee: !live && registering && playerCount(t) === 0,
    canStart: !live && registering,
    canEnd: !live && (registering || running),
  };
}

exports.adminList = asyncHandler(async (req, res) => {
  await catalog.loadFromDb().catch(() => {});
  const game = String(req.query.game || "");
  const lifecycle = String(req.query.lifecycle || "");
  const filter = {};
  if (catalog.GAMES.includes(game)) filter.game = game;
  if (["registering", "running", "finished", "cancelled"].includes(lifecycle)) {
    filter.lifecycle = lifecycle;
  } else {
    filter.lifecycle = { $in: ["registering", "running"] };
  }

  const rows = await ArenaTournament.find(filter).sort({ startAt: 1 }).limit(120).lean();
  const data = [];
  for (const t of rows) {
    const live = await isRunningWithPlayers(t);
    data.push(serializeAdmin(t, flagsFor(t, live)));
  }

  res.json({
    status: "success",
    results: data.length,
    data: {
      catalog: catalog.serializeCatalog(),
      tournaments: data,
    },
  });
});

exports.adminUpdateCatalogTier = asyncHandler(async (req, res) => {
  const tierId = String(req.params.tierId || "");
  const base = catalog.TIERS.find((t) => t.id === tierId);
  if (!base) throw new ApiError("فئة البطولة غير موجودة", 404);

  const nameAr = req.body?.nameAr != null ? String(req.body.nameAr).trim().slice(0, 40) : undefined;
  const feeRaw = req.body?.entryFee;
  const entryFee = feeRaw != null ? toInt(feeRaw) : undefined;
  if (nameAr !== undefined && !nameAr) throw new ApiError("اسم الفئة مطلوب", 400);
  if (entryFee !== undefined && entryFee < 0) throw new ApiError("سعر الدخول غير صالح", 400);

  const doc = await ArenaTournamentSettings.getDefaults();
  const tiers = Array.isArray(doc.tiers) ? doc.tiers.map((x) => ({ ...x.toObject?.() || x })) : [];
  const idx = tiers.findIndex((t) => t.id === tierId);
  const next = {
    id: tierId,
    ...(idx >= 0 ? tiers[idx] : {}),
    ...(nameAr !== undefined ? { nameAr } : {}),
    ...(entryFee !== undefined ? { entryFee } : {}),
  };
  if (idx >= 0) tiers[idx] = next;
  else tiers.push(next);
  doc.tiers = tiers;
  await doc.save();
  catalog.applyOverrides(catalog.overridesFromSettings(doc));

  const resolved = catalog.getTier(tierId);
  await ArenaTournament.updateMany(
    {
      origin: "house",
      lifecycle: "registering",
      tierId,
      adminEdited: { $ne: true },
      participants: { $size: 0 },
    },
    {
      $set: {
        ...(resolved
          ? {
              entryFee: resolved.entryFee,
              guaranteedPrize: resolved.guaranteedPrize,
            }
          : {}),
      },
    }
  );
  if (resolved) {
    for (const game of catalog.GAMES) {
      await ArenaTournament.updateMany(
        {
          origin: "house",
          lifecycle: "registering",
          game,
          tierId,
          adminEdited: { $ne: true },
          participants: { $size: 0 },
        },
        { $set: { name: catalog.houseName(game, resolved) } }
      );
    }
  }

  logEvent({
    event: "arena_tournament_catalog_updated",
    ...actorMeta(req),
    meta: { tierId, nameAr, entryFee },
  });

  res.json({
    status: "success",
    data: { catalog: catalog.serializeCatalog() },
  });
});

exports.adminUpdateTournament = asyncHandler(async (req, res) => {
  const t = await ArenaTournament.findById(req.params.id);
  if (!t) throw new ApiError("البطولة غير موجودة", 404);
  await assertNotLive(t);
  if (t.lifecycle === "finished" || t.lifecycle === "cancelled") {
    throw new ApiError("لا يمكن تعديل بطولة منتهية", 409);
  }

  const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 80) : undefined;
  const feeRaw = req.body?.entryFee;
  const entryFee = feeRaw != null ? toInt(feeRaw) : undefined;
  if (name !== undefined && !name) throw new ApiError("اسم البطولة مطلوب", 400);
  if (entryFee !== undefined && entryFee < 0) throw new ApiError("سعر الدخول غير صالح", 400);
  if (entryFee !== undefined && t.lifecycle !== "registering") {
    throw new ApiError("لا يمكن تغيير السعر بعد انطلاق البطولة", 409);
  }
  if (entryFee !== undefined && playerCount(t) > 0) {
    throw new ApiError("لا يمكن تغيير السعر بعد تسجيل لاعبين", 409);
  }

  if (name !== undefined) t.name = name;
  if (entryFee !== undefined) {
    t.entryFee = entryFee;
    t.type = entryFee > 0 ? "paid" : "friendly";
    t.guaranteedPrize = entryFee > 0 ? entryFee * t.maxPlayers : 0;
  }
  t.adminEdited = true;
  await t.save();

  logEvent({
    event: "arena_tournament_updated",
    ...actorMeta(req),
    tournament: t._id,
    meta: { name: t.name, entryFee: t.entryFee },
  });

  const live = await isRunningWithPlayers(t);
  res.json({ status: "success", data: serializeAdmin(t, flagsFor(t, live)) });
});

exports.adminStartTournament = asyncHandler(async (req, res) => {
  const t = await ArenaTournament.findById(req.params.id);
  if (!t) throw new ApiError("البطولة غير موجودة", 404);
  await assertNotLive(t);
  if (t.lifecycle !== "registering") {
    throw new ApiError("يمكن بدء البطولة فقط وهي في مرحلة التسجيل", 409);
  }
  if (playerCount(t) < t.minPlayers) {
    throw new ApiError("لا يكفي لاعبون لبدء البطولة", 409);
  }

  const started = await engine.startTournament(t._id);
  if (!started) {
    throw new ApiError("تعذر بدء البطولة", 409);
  }

  logEvent({
    event: "arena_tournament_admin_start",
    ...actorMeta(req),
    tournament: t._id,
  });

  res.json({ status: "success", data: started });
});

exports.adminEndTournament = asyncHandler(async (req, res) => {
  const t = await ArenaTournament.findById(req.params.id);
  if (!t) throw new ApiError("البطولة غير موجودة", 404);
  await assertNotLive(t);
  if (t.lifecycle === "finished" || t.lifecycle === "cancelled") {
    throw new ApiError("البطولة منتهية مسبقاً", 409);
  }

  const reason = String(req.body?.reason || "Ended by admin").slice(0, 120);
  let result;
  if (t.lifecycle === "running" && toInt(t.gamesCompleted) > 0) {
    result = await engine.finishTournament(t._id);
  } else {
    result = await engine.cancelTournament(t._id, reason, { system: true });
  }

  logEvent({
    event: "arena_tournament_admin_end",
    ...actorMeta(req),
    tournament: t._id,
    meta: { reason, result },
  });

  res.json({ status: "success", data: result || { status: "ended" } });
});
