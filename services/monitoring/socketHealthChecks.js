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
const { PLAYER_STATE } = require("../../utils/poker/playerState");

// Seat states that SHOULD have a live socket (a disconnected/sitting-out seat
// legitimately has none — that's normal reconnect grace, not a zombie).
const CONNECTED_STATES = new Set([
  PLAYER_STATE.ACTIVE_HAND,
  PLAYER_STATE.SEATED,
  PLAYER_STATE.WAITING,
]);

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

/**
 * Inverse of orphan-room: a poker seat whose human occupant SHOULD be connected
 * but has no socket in the room — the seat-without-socket zombie (e.g. the
 * spectate→sit→disconnect path that used to skip the vacate pipeline). Detection
 * only: the source is fixed in the join/disconnect handlers; residuals are
 * surfaced here for the dashboard + admin `unstickPlayer`, not auto-repaired
 * (targeting a specific seat needs cluster-safe per-user presence).
 */
async function checkSeatWithoutSocket() {
  const findings = [];
  const io = getMainIo();
  if (!io) return findings;
  const pokerNsp = io.of("/table-game");
  for (const tableId of listActivePokerTableIds()) {
    const game = await getLiveTableGameForAdmin(tableId);
    if (!game) continue;
    const expected = game.seats.filter(
      (s) => !s.isBot && CONNECTED_STATES.has(s.playerState)
    ).length;
    const roomSize = countSocketsInRoom(pokerNsp, `tg:${tableId}`);
    if (expected > 0 && roomSize < expected) {
      findings.push(
        makeFinding({
          check: "seat_without_socket",
          severity: "warning",
          tableId,
          message: `Poker table ${tableId}: ${expected} connected human seat(s) but only ${roomSize} socket(s) in room — possible zombie seat`,
          meta: { expected, roomSize },
        })
      );
    }
  }
  return findings;
}

async function run() {
  const [orphan, zombie] = await Promise.all([
    checkOrphanRoomMembership(),
    checkSeatWithoutSocket(),
  ]);
  return { findings: [...orphan, ...zombie] };
}

module.exports = { run, checkOrphanRoomMembership, checkSeatWithoutSocket };
