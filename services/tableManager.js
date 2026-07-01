/**
 * TableManager — sole authority for table lifecycle, player allocation, queues, and spectators.
 * All REST handlers and socket handlers should go through this instead of calling
 * tableAllocationService / pokerTableAllocationService directly where possible.
 *
 * Phase 2: orchestration layer. The underlying join transactions still live in
 * tableAllocationService.js and pokerTableAllocationService.js to preserve wire compatibility.
 */
const tableFactory = require("./tableFactory");
const { allocate } = require("./tableAllocator");

// These are required lazily to avoid circular dependency issues at boot.
// Spectator and queue services are lightweight singletons with no circular deps.
let _spectatorService = null;
let _waitingQueueService = null;
let _vipTableService = null;

function spectatorService() {
  if (!_spectatorService) _spectatorService = require("./spectatorService");
  return _spectatorService;
}

function waitingQueueService() {
  if (!_waitingQueueService) _waitingQueueService = require("./waitingQueueService");
  return _waitingQueueService;
}

function vipTableService() {
  if (!_vipTableService) _vipTableService = require("./vipTableService");
  return _vipTableService;
}

class TableManager {
  // ─── Allocation ───────────────────────────────────────────────────────────

  /**
   * Find best available slot given game parameters.
   * Does NOT perform the actual join (no wallet lock, no seat push).
   * Returns a Table document.
   */
  async findTable({ gameType, tier, buyIn, tableKind, preferTableId, userId, session }) {
    return allocate({ gameType, tier, buyIn, tableKind, preferTableId, userId, session });
  }

  // ─── Queue ────────────────────────────────────────────────────────────────

  async enqueuePlayer(userId, tableId, gameType, buyIn) {
    return waitingQueueService().enqueue({ userId, tableId, gameType, buyIn });
  }

  /**
   * Pop the first queued player and emit queue_seat_available to their socket.
   * @param {string} tableId
   * @param {string} gameType
   * @param {import('socket.io').Namespace} [nsp]
   */
  async dequeueNext(tableId, gameType, nsp) {
    return waitingQueueService().dequeueNext(tableId, gameType, nsp);
  }

  async cancelQueue(userId, tableId, gameType) {
    return waitingQueueService().cancel(userId, tableId, gameType);
  }

  // ─── Spectators ───────────────────────────────────────────────────────────

  addSpectator(userId, tableId, socketId) {
    return spectatorService().add(tableId, userId, socketId);
  }

  removeSpectator(userId, tableId) {
    return spectatorService().remove(tableId, userId);
  }

  getSpectators(tableId) {
    return spectatorService().getSocketIds(tableId);
  }

  isSpectating(userId, tableId) {
    return spectatorService().isSpectating(tableId, userId);
  }

  clearTableSpectators(tableId) {
    return spectatorService().clearTable(tableId);
  }

  // ─── Scaling ──────────────────────────────────────────────────────────────

  /**
   * Destroy an idle dynamic table (no seated humans, idle > 15 min).
   * Delegates to tableFactory.destroyOrArchiveTable which will DELETE dynamic tables.
   */
  async destroyIdleDynamic(tableId) {
    await this.clearTableSpectators(tableId);
    return tableFactory.destroyOrArchiveTable(tableId, { reason: "idle" });
  }

  // ─── VIP controls ─────────────────────────────────────────────────────────

  async kickPlayer(tableId, targetUserId, requesterId) {
    return vipTableService().kick(tableId, targetUserId, requesterId);
  }

  async lockTable(tableId, requesterId) {
    return vipTableService().lockTable(tableId, requesterId);
  }

  async unlockTable(tableId, requesterId) {
    return vipTableService().unlockTable(tableId, requesterId);
  }

  async transferOwnership(tableId, newOwnerId, requesterId) {
    return vipTableService().transferOwnership(tableId, newOwnerId, requesterId);
  }

  async toggleSpectators(tableId, requesterId) {
    return vipTableService().toggleSpectators(tableId, requesterId);
  }

  async toggleBots(tableId, requesterId) {
    return vipTableService().toggleBots(tableId, requesterId);
  }

  async destroyVipTable(tableId, requesterId) {
    await this.clearTableSpectators(tableId);
    return vipTableService().destroy(tableId, requesterId);
  }
}

module.exports = new TableManager();
