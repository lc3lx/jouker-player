/**
 * Socket health checks: reporting-only signals for the dashboard/health
 * score. Duplicate-tab false-disconnects are already self-healed at the
 * source by socketPresenceService (see TABLE_LIFECYCLE_AUDIT.md) — this
 * module doesn't re-detect or re-repair that, it only surfaces standing
 * room-membership anomalies (a room with more sockets than the live roster
 * expects) as an informational signal, reusing tableGcService's existing
 * countSocketsInRoom/cardRoomName rather than a second implementation.
 */
const { getMainIo } = require("../../utils/lobbyRealtime");
const { countSocketsInRoom, cardRoomName } = require("../tableGcService");
const { listActivePokerTableIds, getLiveTableGameForAdmin } = require("../../sockets/tableGame");
const roomManager = require("../../rooms/roomManager");

function makeFinding({ check, severity, tableId = null, message, meta = {} }) {
  return {
    check,
    severity,
    tableId: tableId ? String(tableId) : null,
    playerId: null,
    socketId: null,
    message,
    meta,
    repaired: false,
    repairAction: null,
    repairResult: null,
  };
}

/** Tolerance above expected humans before flagging — legitimate multi-tab/spectators are normal. */
const ROOM_EXCESS_TOLERANCE = 3;

async function checkOrphanRoomMembership() {
  const findings = [];
  const io = getMainIo();
  if (!io) return findings;

  const pokerNsp = io.of("/table-game");
  const gameNsp = io.of("/game");

  const pokerTableIds = listActivePokerTableIds();
  for (const tableId of pokerTableIds) {
    const game = await getLiveTableGameForAdmin(tableId);
    if (!game) continue;
    const humanSeats = game.seats.filter((s) => !s.isBot).length;
    const roomSize = countSocketsInRoom(pokerNsp, `tg:${tableId}`);
    if (roomSize > humanSeats + ROOM_EXCESS_TOLERANCE) {
      findings.push(
        makeFinding({
          check: "orphan_room_membership",
          severity: "warning",
          tableId,
          message: `Poker room tg:${tableId} has ${roomSize} sockets but only ${humanSeats} human seats`,
          meta: { roomSize, humanSeats },
        })
      );
    }
  }

  for (const [tableId, game] of roomManager.trixGamesByTableId.entries()) {
    if (!game) continue;
    const humanSeats = (game.players || []).filter((p) => !p.isBot).length;
    const roomSize = countSocketsInRoom(gameNsp, cardRoomName("trix", tableId));
    if (roomSize > humanSeats + ROOM_EXCESS_TOLERANCE) {
      findings.push(
        makeFinding({
          check: "orphan_room_membership",
          severity: "warning",
          tableId,
          message: `Trix room has ${roomSize} sockets but only ${humanSeats} human seats`,
          meta: { roomSize, humanSeats },
        })
      );
    }
  }

  for (const [tableId, game] of roomManager.tarneeb41GamesByTableId.entries()) {
    if (!game) continue;
    const humanSeats = (game.players || []).filter((p) => !p.isBot).length;
    const roomSize = countSocketsInRoom(gameNsp, cardRoomName("tarneeb41", tableId));
    if (roomSize > humanSeats + ROOM_EXCESS_TOLERANCE) {
      findings.push(
        makeFinding({
          check: "orphan_room_membership",
          severity: "warning",
          tableId,
          message: `Tarneeb41 room has ${roomSize} sockets but only ${humanSeats} human seats`,
          meta: { roomSize, humanSeats },
        })
      );
    }
  }

  return findings;
}

async function run() {
  const findings = await checkOrphanRoomMembership();
  return { findings };
}

module.exports = { run, checkOrphanRoomMembership };
