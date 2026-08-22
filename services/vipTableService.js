/**
 * VipTableService — VIP owner controls for VIP tables.
 * All write functions verify that the requester is the table owner before acting.
 */
const crypto = require("crypto");
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
  if (!Number.isSafeInteger(Number(buyIn)) || Number(buyIn) <= 0) {
    throw new ApiError("buyIn must be a positive whole number", 400);
  }
  // Invite-only VIP tables are private. A password is stored for the join
  // gate, but invited friends enter through allowedUsers — generate one when
  // the host does not supply it so the create UI stays invite-first.
  const privateTable = isPrivate !== false;
  let tablePassword = password;
  if (privateTable) {
    const trimmed = tablePassword != null ? String(tablePassword).trim() : "";
    tablePassword = trimmed.length >= 4 ? trimmed : crypto.randomBytes(12).toString("base64url");
  }
  const doc = await tableFactory.createVipTable({
    gameType,
    tier,
    buyIn: Number(buyIn),
    capacity: capacity ? Number(capacity) : undefined,
    ownerId: req.user._id,
    displayName,
    isPrivate: privateTable,
    password: tablePassword,
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

  const pokerTable = await Table.findById(id).select("gameType seats");
  if (pokerTable?.gameType === "poker") {
    if (!pokerTable.seats.some((seat) => String(seat.user) === String(targetUserId))) {
      throw new ApiError("Player is not seated at this table", 404);
    }
    // A live Poker hand owns the authoritative chip totals in memory. Use the
    // standard deferred leave flow so a player is only refunded post-settlement.
    const { markPendingPermanentLeave, scheduleDeferredPermanentLeave } = require("./pokerVacateService");
    const { requestLivePokerLeave } = require("../sockets/pokerTableGameBridge");
    await markPendingPermanentLeave({ tableId: id, userId: targetUserId });
    await requestLivePokerLeave(String(id), targetUserId);
    scheduleDeferredPermanentLeave({ tableId: id, userId: targetUserId });
    try {
      const { getMainIo } = require("../utils/lobbyRealtime");
      const tableNsp = getMainIo()?.of("/table-game");
      if (tableNsp) {
        const sockets = await tableNsp.in(`tg:${String(id)}`).fetchSockets();
        for (const socket of sockets) {
          if (String(socket.data?.userId || "") === String(targetUserId)) {
            socket.emit("kicked_from_table", { tableId: String(id), reason: "owner_kick" });
          }
        }
      }
    } catch (_) {
      // The durable leave has already been recorded; notification is best effort.
    }
    emitTablesUpdated({ reason: "vip_kick_requested", tableId: String(id) });
    return res.status(202).json({
      status: "success",
      message: "Player removal requested; cash-out completes after any active hand settles",
    });
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
  const { syncLivePokerTableAfterJoin } = require("../sockets/pokerTableGameBridge");
  await syncLivePokerTableAfterJoin(String(req.params.id));
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
  if (table.gameType === "poker") {
    const { syncLivePokerTableAfterJoin } = require("../sockets/pokerTableGameBridge");
    await syncLivePokerTableAfterJoin(String(id));
  }
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

  if (table.gameType === "poker") {
    const {
      getTableGameDebugSnapshot,
      evictTableFromRegistry,
    } = require("../sockets/pokerTableGameBridge");
    const live = getTableGameDebugSnapshot(String(id));
    if (table.seats.length > 0 || live?.running) {
      throw new ApiError(
        "Remove all Poker players and wait for the active hand to finish before destroying this table",
        409
      );
    }
    // Do not leave an orphaned in-memory engine broadcasting a deleted table.
    evictTableFromRegistry(String(id));
    await tableFactory.destroyOrArchiveTable(id, { reason: "owner_destroy" });
    return res.status(200).json({ status: "success", message: "Table destroyed" });
  }

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
