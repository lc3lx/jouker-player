const mongoose = require("mongoose");
const { AccessToken } = require("livekit-server-sdk");
const Table = require("../models/tableModel");
const ApiError = require("../utils/apiError");

function toSafeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

/**
 * LiveKit room name = Mongo table id (valid LiveKit room id: hex ObjectId string).
 */
function liveKitRoomNameForTable(tableId) {
  const id = String(tableId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return id;
}

async function assertUserSeatedAtPokerTable(userId, tableId) {
  const room = liveKitRoomNameForTable(tableId);
  if (!room) {
    throw new ApiError("Invalid tableId", 400);
  }

  const table = await Table.findById(tableId).select("seats gameType").lean();
  if (!table) {
    throw new ApiError("Table not found", 404);
  }

  const gt = String(table.gameType || "poker");
  if (gt !== "poker") {
    throw new ApiError("Video is only available on poker tables", 403);
  }

  const uid = String(userId);
  const seated =
    Array.isArray(table.seats) && table.seats.some((s) => String(s.user) === uid);
  if (!seated) {
    throw new ApiError("You must be seated at this table to use video chat", 403);
  }

  return { roomName: room };
}

/**
 * Mint a short-lived LiveKit JWT. Unauthorized users cannot obtain a token
 * (seating is verified against Mongo).
 */
async function createPokerTableVideoToken({ userId, tableId, displayName }) {
  const livekitUrl = (process.env.LIVEKIT_URL || "").trim();
  if (!livekitUrl) {
    throw new ApiError("LiveKit is not configured (LIVEKIT_URL)", 503);
  }

  const { roomName } = await assertUserSeatedAtPokerTable(userId, tableId);

  const ttlSec = Math.max(
    120,
    Math.min(7200, toSafeInt(process.env.LIVEKIT_TOKEN_TTL_SEC, 900))
  );

  const name =
    displayName && String(displayName).trim().length > 0
      ? String(displayName).trim().slice(0, 128)
      : undefined;

  const at = new AccessToken(undefined, undefined, {
    identity: String(userId),
    ttl: ttlSec,
    name,
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const token = await at.toJwt();

  return {
    url: livekitUrl,
    token,
    roomName,
    expiresInSec: ttlSec,
  };
}

module.exports = {
  liveKitRoomNameForTable,
  assertUserSeatedAtPokerTable,
  createPokerTableVideoToken,
};
