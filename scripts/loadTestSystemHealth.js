/* eslint-disable no-console */
/**
 * Stress-test scenarios loadTestTableGame.js doesn't cover: multiple
 * distinct real identities (not one token opening many sockets), a
 * mass-simultaneous disconnect (not a steady trickle), a queue-storm against
 * a full table, and rapid join/leave cycling. Reuses the same
 * socket.io-client connection pattern as loadTestTableGame.js and the app's
 * own createToken util (no separate JWT-signing logic) rather than
 * duplicating either.
 *
 * Requires N pre-existing, pre-funded users (LOAD_USER_IDS) and a target
 * table (LOAD_TABLE_ID) — same operator-provisions-fixtures convention as
 * loadTestTableGame.js. Polls GET /admin/system-health afterward (LOAD_ADMIN_TOKEN)
 * and reports pass/fail against simple thresholds.
 *
 * Usage:
 *   LOAD_USER_IDS=<id1,id2,...> LOAD_TABLE_ID=<id> LOAD_ADMIN_TOKEN=<jwt> \
 *     LOAD_API_URL=http://localhost:1099 LOAD_SOCKET_URL=http://localhost:1099/table-game \
 *     node scripts/loadTestSystemHealth.js
 */
require("dotenv").config();
const { io } = require("socket.io-client");
const createToken = require("../utils/createToken");

const API_URL = process.env.LOAD_API_URL || "http://localhost:1099";
const SOCKET_URL = process.env.LOAD_SOCKET_URL || "http://localhost:1099/table-game";
const TABLE_ID = process.env.LOAD_TABLE_ID || "";
const USER_IDS = (process.env.LOAD_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const ADMIN_TOKEN = process.env.LOAD_ADMIN_TOKEN || "";
const BUY_IN = Number(process.env.LOAD_BUY_IN || 10000);

if (!TABLE_ID || USER_IDS.length === 0) {
  console.error("Missing LOAD_TABLE_ID or LOAD_USER_IDS (comma-separated pre-funded user ids)");
  process.exit(1);
}

function tokensForUsers() {
  return USER_IDS.map((uid) => ({ userId: uid, token: createToken(uid) }));
}

function connectSocket(token, label) {
  return new Promise((resolve) => {
    const sock = io(SOCKET_URL, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });
    sock.on("connect", () => resolve(sock));
    sock.on("connect_error", (e) => {
      console.error(`connect_error[${label}]`, e.message);
      resolve(null);
    });
  });
}

async function apiCall(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, data };
}

/** Scenario 1: mass-simultaneous disconnect then mass-simultaneous reconnect. */
async function massDisconnectScenario(identities) {
  console.log(`[scenario] mass-disconnect: connecting ${identities.length} identities`);
  const sockets = await Promise.all(
    identities.map(({ token }, i) => connectSocket(token, `mass-${i}`))
  );
  const live = sockets.filter(Boolean);
  live.forEach((s) => s.emit("subscribe-table", { tableId: TABLE_ID }));
  await new Promise((r) => setTimeout(r, 1000));

  console.log(`[scenario] mass-disconnect: disconnecting ${live.length} sockets simultaneously`);
  live.forEach((s) => s.disconnect());
  await new Promise((r) => setTimeout(r, 500));

  console.log(`[scenario] mass-disconnect: reconnecting all ${live.length} simultaneously`);
  const reconnected = await Promise.all(
    identities.map(({ token }, i) => connectSocket(token, `reconnect-${i}`))
  );
  reconnected.filter(Boolean).forEach((s) => s.emit("subscribe-table", { tableId: TABLE_ID }));
  await new Promise((r) => setTimeout(r, 1000));
  reconnected.filter(Boolean).forEach((s) => s.disconnect());

  return { connected: live.length, reconnected: reconnected.filter(Boolean).length };
}

/** Scenario 2: many identities hit join concurrently (queue storm if the table is full). */
async function queueStormScenario(identities) {
  console.log(`[scenario] queue-storm: ${identities.length} concurrent join requests`);
  const results = await Promise.all(
    identities.map(({ token }) =>
      apiCall(`/api/v1/tables/${TABLE_ID}/join`, { method: "POST", token, body: { buyIn: BUY_IN } })
    )
  );
  const outcomes = results.reduce((acc, r) => {
    const key = r.data?.data?.queued ? "queued" : r.status === 200 ? "seated" : "rejected";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return outcomes;
}

/** Scenario 3: rapid join/leave cycling per identity. */
async function rapidJoinLeaveScenario(identities, cycles = 5) {
  console.log(`[scenario] rapid-join-leave: ${identities.length} identities x ${cycles} cycles`);
  let joinOk = 0;
  let leaveOk = 0;
  for (let c = 0; c < cycles; c += 1) {
    await Promise.all(
      identities.map(async ({ token }) => {
        const j = await apiCall(`/api/v1/tables/${TABLE_ID}/join`, {
          method: "POST",
          token,
          body: { buyIn: BUY_IN },
        });
        if (j.status === 200) joinOk += 1;
        const l = await apiCall(`/api/v1/tables/${TABLE_ID}/leave`, { method: "POST", token });
        if (l.status === 200) leaveOk += 1;
      })
    );
  }
  return { joinOk, leaveOk, expectedMax: identities.length * cycles };
}

async function reportSystemHealth() {
  if (!ADMIN_TOKEN) {
    console.log("[health] LOAD_ADMIN_TOKEN not set — skipping /admin/system-health check");
    return null;
  }
  const { status, data } = await apiCall("/api/v1/admin/system-health", { token: ADMIN_TOKEN });
  return { status, snapshot: data?.data };
}

async function main() {
  const identities = tokensForUsers();

  const massDisconnect = await massDisconnectScenario(identities);
  const queueStorm = await queueStormScenario(identities);
  const rapidCycle = await rapidJoinLeaveScenario(identities);
  const health = await reportSystemHealth();

  const summary = { massDisconnect, queueStorm, rapidCycle, health };
  console.log(JSON.stringify(summary, null, 2));

  let pass = true;
  if (health?.snapshot) {
    if (health.snapshot.overallScore < 80) {
      console.error(`FAIL: overall health score ${health.snapshot.overallScore} < 80 after stress scenarios`);
      pass = false;
    }
    const critical = Object.entries(health.snapshot.subsystems || {}).filter(([, s]) => s.status === "critical");
    if (critical.length > 0) {
      console.error(`FAIL: critical subsystems after stress scenarios: ${critical.map(([n]) => n).join(", ")}`);
      pass = false;
    }
  }
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("load test failed:", e);
  process.exit(1);
});
