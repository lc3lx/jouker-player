const jwt = require("jsonwebtoken");
const Table = require("../models/tableModel");
const Tournament = require("../models/tournamentModel");

function getTokenFromHandshake(socket) {
  // Prefer auth token, then Authorization header: "Bearer <token>", then query
  const auth = socket.handshake.auth || {};
  if (auth.token) return auth.token.replace(/^Bearer\s+/i, "");
  const header = socket.handshake.headers && socket.handshake.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.split(" ")[1];
  const query = socket.handshake.query || {};
  if (query.token) return String(query.token).replace(/^Bearer\s+/i, "");
  return null;
}

function initRTC(io) {
  const nsp = io.of("/rtc");

  // Auth middleware
  nsp.use((socket, next) => {
    try {
      const token = getTokenFromHandshake(socket);
      if (!token) return next(new Error("Authentication token missing"));
      const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
      socket.userId = decoded.userId;
      next();
    } catch (err) {
      next(new Error("Invalid token"));
    }
  });

  nsp.on("connection", (socket) => {
    // Join a room (e.g., table or private room)
    socket.on("join-room", async (payload) => {
      try {
        const { roomId, type } =
          typeof payload === "string" ? { roomId: payload, type: undefined } : payload || {};
        if (!roomId) return;

        // Optional authorization by type
        if (type === "table") {
          const table = await Table.findById(roomId).select("seats tableNumber");
          if (!table) return socket.emit("join-denied", { reason: "table-not-found" });
          const ok = table.seats.some((s) => String(s.user) === String(socket.userId));
          if (!ok) return socket.emit("join-denied", { reason: "not-at-this-table" });
        } else if (type === "tournament") {
          const t = await Tournament.findById(roomId).select("participants");
          if (!t) return socket.emit("join-denied", { reason: "tournament-not-found" });
          const ok = t.participants.some((p) => String(p.user) === String(socket.userId));
          if (!ok) return socket.emit("join-denied", { reason: "not-in-this-tournament" });
        }

        socket.join(roomId);
        // Notify others
        socket
          .to(roomId)
          .emit("peer-joined", { socketId: socket.id, userId: socket.userId });
        // Send current peers in room to the new socket
        const room = nsp.adapter.rooms.get(roomId) || new Set();
        const peers = Array.from(room).filter((id) => id !== socket.id);
        socket.emit("peers", { roomId, peers });
      } catch (err) {
        socket.emit("join-denied", { reason: "internal-error" });
      }
    });

    // Leave a room
    socket.on("leave-room", (roomId) => {
      if (!roomId) return;
      socket.leave(roomId);
      socket.to(roomId).emit("peer-left", { socketId: socket.id, userId: socket.userId });
    });

    // Signaling: offer/answer/ice-candidate
    socket.on("offer", ({ to, sdp }) => {
      if (to && sdp) nsp.to(to).emit("offer", { from: socket.id, sdp });
    });
    socket.on("answer", ({ to, sdp }) => {
      if (to && sdp) nsp.to(to).emit("answer", { from: socket.id, sdp });
    });
    socket.on("ice-candidate", ({ to, candidate }) => {
      if (to && candidate) nsp.to(to).emit("ice-candidate", { from: socket.id, candidate });
    });

    socket.on("disconnecting", () => {
      for (const roomId of socket.rooms) {
        if (roomId !== socket.id) {
          socket.to(roomId).emit("peer-left", { socketId: socket.id, userId: socket.userId });
        }
      }
    });
  });
}

module.exports = { initRTC };
