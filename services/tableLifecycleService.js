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

  // Static tables are permanent (the fixed 4-per-tier scaffold) — archiving
  // them would hide them from the lobby for the rest of the process's
  // uptime, with no runtime path back to "open". Reset instead, mirroring
  // pokerTableGcService's existing tableKind-aware treatment.
  const kindProbe = session
    ? await Table.findById(tid).select("tableKind gameType").session(session)
    : await Table.findById(tid).select("tableKind gameType");
  if (!kindProbe) return { archived: false, reason: "not_found" };

  if (kindProbe.tableKind === "static") {
    const resetQ = Table.findByIdAndUpdate(
      tid,
      {
        $set: {
          status: kindProbe.gameType === "poker" ? "waiting" : "open",
          seats: [],
          waitingQueue: [],
          activeSettlementId: null,
        },
      },
      { new: true }
    );
    const resetDoc = session ? await resetQ.session(session) : await resetQ;
    if (!resetDoc) return { archived: false, reason: "not_found" };

    emitTablesUpdated({
      gameType: resetDoc.gameType || "poker",
      reason: "table_reset",
      tableId: tid,
    });
    return { archived: false, reset: true, tableId: tid, gameType: resetDoc.gameType };
  }

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
