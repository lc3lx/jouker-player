/**
 * Mongo table lifecycle: archive finished/abandoned tables so lobby never re-surfaces dead matches.
 */
const Table = require("../models/tableModel");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");

const LOBBY_EXCLUDED_STATUSES = ["closed", "archived"];

/**
 * @param {import('mongoose').ClientSession} [session]
 */
async function archiveTableDocument(tableId, { reason = "game_complete", session } = {}) {
  const tid = String(tableId);
  const q = Table.findByIdAndUpdate(
    tid,
    {
      $set: {
        status: "archived",
        seats: [],
        waitingQueue: [],
        activeSettlementId: null,
      },
    },
    { new: true }
  );
  const doc = session ? await q.session(session) : await q;
  if (!doc) return { archived: false, reason: "not_found" };

  emitTablesUpdated({
    gameType: doc.gameType || "poker",
    reason: reason === "abandoned" ? "table_abandoned" : "table_archived",
    tableId: tid,
  });
  return { archived: true, tableId: tid, gameType: doc.gameType };
}

function isLobbyVisibleStatus(status) {
  return !LOBBY_EXCLUDED_STATUSES.includes(String(status || ""));
}

module.exports = {
  LOBBY_EXCLUDED_STATUSES,
  archiveTableDocument,
  isLobbyVisibleStatus,
};
