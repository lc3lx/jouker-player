/* eslint-disable no-console */
const { io } = require("socket.io-client");

const SERVER_URL = process.env.LOAD_SOCKET_URL || "http://localhost:8000/table-game";
const TABLE_ID = process.env.LOAD_TABLE_ID || "";
const TOKEN = process.env.LOAD_TOKEN || "";
const PLAYERS = Math.max(1, Number(process.env.LOAD_PLAYERS || 100));
const DURATION_MS = Math.max(5000, Number(process.env.LOAD_DURATION_MS || 30000));

if (!TABLE_ID || !TOKEN) {
  console.error("Missing LOAD_TABLE_ID or LOAD_TOKEN");
  process.exit(1);
}

const sockets = [];
let accepted = 0;
let rejected = 0;
let connected = 0;
let reconnects = 0;

function spawn(i) {
  const sock = io(SERVER_URL, {
    auth: { token: TOKEN },
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 100,
  });
  sockets.push(sock);

  sock.on("connect", () => {
    connected += 1;
    sock.emit("subscribe-table", { tableId: TABLE_ID, clientSeed: `load-${i}` });
  });

  sock.on("state:me", () => {});

  sock.on("action_result", (res) => {
    if (res?.status === "accepted") accepted += 1;
    else rejected += 1;
  });
}

for (let i = 0; i < PLAYERS; i += 1) spawn(i);

// Reconnect storm simulation: recycle 10% of sockets every 5s.
const stormTimer = setInterval(() => {
  const take = Math.max(1, Math.floor(sockets.length * 0.1));
  for (let i = 0; i < take; i += 1) {
    const s = sockets[i];
    if (!s) continue;
    try {
      s.disconnect();
      reconnects += 1;
      s.connect();
      s.emit("subscribe-table", { tableId: TABLE_ID, clientSeed: `storm-${Date.now()}-${i}` });
    } catch (e) {}
  }
}, 5000);

setTimeout(() => {
  clearInterval(stormTimer);
  for (const s of sockets) {
    try { s.disconnect(); } catch (e) {}
  }
  console.log(JSON.stringify({
    connected,
    reconnects,
    players: PLAYERS,
    accepted,
    rejected,
    durationMs: DURATION_MS,
  }));
  process.exit(0);
}, DURATION_MS);

