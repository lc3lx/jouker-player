/**
 * VipTableService — VIP owner controls for VIP tables.
 * All write functions verify that the requester is the table owner before acting.
 */
const asyncHandler = require("express-async-handler");
const bcrypt = require("bcryptjs");
const ApiError = require("../utils/apiError");
const Table = require("../models/tableModel");
const { withMongoTransaction, releaseTableSeatToBalance } = require("./walletLedgerService");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");
const tableFactory = require("./tableFactory");
const roomManager = require("../rooms/roomManager");

// ─── Ownership guard ─────────────────────────────────────────────────────

async function assertOwner(tableId, requesterId) {
  const table = await Table.findById(tableId).select("owner tableKind");
  if (!table) throw new ApiError("Table not found", 404);
  if (table.tableKind !== "vip") throw new ApiError("Not a VIP table", 400);
  if (String(table.owner) !== String(requesterId)) {
    throw new ApiError("Only the table owner can perform this action", 403);
  }
  return table;
}

// ─── VIP user guard middleware ────────────────────────────────────────────

/**
 * Express middleware: requires req.user.vip.active === true and not expired.
 */
exports.assertVipUser = (req, res, next) => {
  const vip = req.user?.vip;
  if (!vip?.active) return next(new ApiError("VIP subscription required", 403));
  if (vip.expiresAt && new Date(vip.expiresAt) < new Date()) {
    return next(new ApiError("VIP subscription has expired", 403));
  }
  next();
};

// ─── Owner control handlers ───────────────────────────────────────────────

/**
 * POST /tables/vip
 * Create a new VIP table (VIP user only).
 */
exports.createVipHandler = asyncHandler(async (req, res) => {
  const { gameType, tier, buyIn, capacity, displayName, isPrivate, password, settings } = req.body;
  if (!gameType || !tier || !buyIn) {
    throw new ApiError("gameType, tier and buyIn are required", 400);
  }
  const doc = await tableFactory.createVipTable({
    gameType,
    tier,
    buyIn: Number(buyIn),
    capacity: capacity ? Number(capacity) : undefined,
    ownerId: req.user._id,
    displayName,
    isPrivate: !!isPrivate,
    password,
    settings,
  });
  res.status(201).json({ status: "success", data: doc });
});

/**
 * POST /tables/:id/vip/kick
 * Owner kicks a seated player, refunding their buy-in.
 */
exports.kick = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { userId: targetUserId } = req.body;
  if (!targetUserId) throw new ApiError("userId required in body", 400);

  await assertOwner(id, req.user._id);

  const { isTableSettlementBlocked } = require("./gameSettlementService");
  if (await isTableSettlementBlocked(id)) {
    throw new ApiError("Settlement in progress — kicking is temporarily blocked", 409);
  }

  await withMongoTransaction(async (session) => {
    const tableTx = await Table.findById(id).session(session);
    if (!tableTx) throw new Error("TABLE_NOT_FOUND");
    const idx = tableTx.seats.findIndex((s) => String(s.user) === String(targetUserId));
    if (idx === -1) throw new Error("NOT_SEATED");
    const chips = tableTx.seats[idx].chips || 0;
    tableTx.seats.splice(idx, 1);
    await tableTx.save({ session });
    if (chips > 0) {
      await releaseTableSeatToBalance({
        session,
        userId: targetUserId,
        seatChips: chips,
        tableId: id,
        meta: { reason: "vip_kick" },
      });
    }
  });

  // Notify kicked player via socket (best-effort).
  const sock =
    roomManager.getTrixUserSocket(String(targetUserId)) ||
    roomManager.getTarneeb41UserSocket(String(targetUserId));
  if (sock) sock.emit("kicked_from_table", { tableId: String(id), reason: "owner_kick" });

  emitTablesUpdated({ reason: "vip_kick", tableId: String(id) });
  res.status(200).json({ status: "success", message: "Player kicked" });
});

/**
 * POST /tables/:id/vip/lock
 * Lock table — no new players can join.
 */
exports.lockTable = asyncHandler(async (req, res) => {
  await assertOwner(req.params.id, req.user._id);
  await Table.findByIdAndUpdate(req.params.id, { $set: { "settings.isLocked": true } });
  emitTablesUpdated({ reason: "vip_lock", tableId: String(req.params.id) });
  res.status(200).json({ status: "success", message: "Table locked" });
});

/**
 * POST /tables/:id/vip/unlock
 */
exports.unlockTable = asyncHandler(async (req, res) => {
  await assertOwner(req.params.id, req.user._id);
  await Table.findByIdAndUpdate(req.params.id, { $set: { "settings.isLocked": false } });
  emitTablesUpdated({ reason: "vip_unlock", tableId: String(req.params.id) });
  res.status(200).json({ status: "success", message: "Table unlocked" });
});

/**
 * POST /tables/:id/vip/transfer-ownership
 */
exports.transferOwnership = asyncHandler(async (req, res) => {
  const { newOwnerId } = req.body;
  if (!newOwnerId) throw new ApiError("newOwnerId required", 400);
  await assertOwner(req.params.id, req.user._id);
  await Table.findByIdAndUpdate(req.params.id, { $set: { owner: newOwnerId } });
  emitTablesUpdated({ reason: "vip_transfer", tableId: String(req.params.id) });
  res.status(200).json({ status: "success", message: "Ownership transferred" });
});

/**
 * POST /tables/:id/vip/toggle-spectators
 */
exports.toggleSpectators = asyncHandler(async (req, res) => {
  await assertOwner(req.params.id, req.user._id);
  const table = await Table.findById(req.params.id).select("settings");
  const next = !table.settings.allowSpectators;
  await Table.findByIdAndUpdate(req.params.id, { $set: { "settings.allowSpectators": next } });
  res.status(200).json({ status: "success", allowSpectators: next });
});

/**
 * POST /tables/:id/vip/toggle-bots
 */
exports.toggleBots = asyncHandler(async (req, res) => {
  await assertOwner(req.params.id, req.user._id);
  const table = await Table.findById(req.params.id).select("settings");
  const next = !table.settings.botsEnabled;
  await Table.findByIdAndUpdate(req.params.id, { $set: { "settings.botsEnabled": next } });
  res.status(200).json({ status: "success", botsEnabled: next });
});

/**
 * POST /tables/:id/vip/start
 * Owner triggers game start if eligible.
 */
exports.start = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertOwner(id, req.user._id);
  const table = await Table.findById(id).select("gameType seats capacity");
  if (!table) throw new ApiError("Table not found", 404);
  if (table.seats.length < 2) throw new ApiError("Not enough players to start", 400);
  // Game-specific start is triggered by the socket layer (e.g. refresh game seats).
  // Here we mark intent and let the countdown fire via existing socket handler.
  emitTablesUpdated({ reason: "vip_start_requested", tableId: String(id) });
  res.status(200).json({ status: "success", message: "Start requested" });
});

/**
 * DELETE /tables/:id
 * Owner destroys the VIP table — ejects all seated players with refunds, then deletes.
 */
exports.destroy = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertOwner(id, req.user._id);

  const { isTableSettlementBlocked } = require("./gameSettlementService");
  if (await isTableSettlementBlocked(id)) {
    throw new ApiError("Settlement in progress — destroying is temporarily blocked", 409);
  }

  const table = await Table.findById(id).select("seats gameType");
  if (!table) throw new ApiError("Table not found", 404);

  // Refund all seated players.
  if (table.seats.length > 0) {
    await withMongoTransaction(async (session) => {
      const tableTx = await Table.findById(id).session(session);
      if (!tableTx) throw new Error("TABLE_NOT_FOUND");
      for (const seat of [...tableTx.seats]) {
        if (seat.chips > 0) {
          await releaseTableSeatToBalance({
            session,
            userId: seat.user,
            seatChips: seat.chips,
            tableId: id,
            meta: { reason: "vip_table_destroyed" },
          });
        }
      }
      tableTx.seats = [];
      await tableTx.save({ session });
    });
  }

  // Delete from Mongo.
  await tableFactory.destroyOrArchiveTable(id, { reason: "owner_destroy" });
  res.status(200).json({ status: "success", message: "Table destroyed" });
});
