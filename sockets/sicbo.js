/**
 * Sic Bo realtime namespace (/sicbo).
 *
 * - JWT handshake auth (mirrors sockets/tableGame.js).
 * - Each socket joins the shared "sicbo" room + a personal "sicbo:user:<id>" room
 *   (personal payout/confirm events; multi-device safe — all a user's sockets get them).
 * - Betting is server-authoritative: place_bet validates the live round window inside
 *   the debit transaction; per-socket rate limit + actionId dedup block spam/replay.
 * - Starts the single global engine loop (startSicboEngine); only the Redis leader node
 *   actually advances rounds.
 */
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");
const roundManager = require("../games/sicbo/sicboRoundManager");
const walletAdapter = require("../games/sicbo/sicboWalletAdapter");
const {
  startSicboEngine,
  getPublicStateForClient,
  ROOM,
  userRoom,
} = require("../services/sicboService");

function getTokenFromHandshake(socket) {
  const auth = socket.handshake.auth || {};
  if (auth.token) return String(auth.token).replace(/^Bearer\s+/i, "");
  const header = socket.handshake.headers && socket.handshake.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.split(" ")[1];
  const query = socket.handshake.query || {};
  if (query.token) return String(query.token).replace(/^Bearer\s+/i, "");
  return null;
}

// ─── Lightweight per-socket anti-abuse ───────────────────────────────────────
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 12; // max bet events per second per socket

function makeRateState() {
  return { windowStart: Date.now(), count: 0, seenActions: new Set(), order: [] };
}

function rateBlocked(state) {
  const now = Date.now();
  if (now - state.windowStart >= RATE_WINDOW_MS) {
    state.windowStart = now;
    state.count = 0;
  }
  state.count += 1;
  return state.count > RATE_MAX;
}

function duplicateAction(state, actionId) {
  if (!actionId) return false;
  if (state.seenActions.has(actionId)) return true;
  state.seenActions.add(actionId);
  state.order.push(actionId);
  if (state.order.length > 200) {
    const old = state.order.shift();
    state.seenActions.delete(old);
  }
  return false;
}

async function sendSnapshot(socket) {
  const state = await getPublicStateForClient();
  let myBets = [];
  let balance = null;
  try {
    if (state?.roundId) myBets = await roundManager.getUserBets(state.roundId, socket.userId);
    balance = await walletAdapter.getBalance(socket.userId);
  } catch (_) {
    /* best-effort */
  }
  socket.emit("sicbo:round_state", { round: state, myBets, balance });
}

function initSicbo(io, { redis } = {}) {
  const nsp = io.of("/sicbo");

  nsp.use((socket, next) => {
    try {
      const token = getTokenFromHandshake(socket);
      if (!token) return next(new Error("Authentication token missing"));
      const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
      socket.userId = decoded.userId;
      socket._rate = makeRateState();
      next();
    } catch (_) {
      next(new Error("Invalid token"));
    }
  });

  nsp.on("connection", (socket) => {
    socket.join(ROOM());
    socket.join(userRoom(socket.userId));
    void sendSnapshot(socket);

    socket.on("sicbo:join", () => {
      void sendSnapshot(socket);
    });

    socket.on("sicbo:place_bet", async (payload, ack) => {
      const respond = (res) => {
        if (typeof ack === "function") ack(res);
        else socket.emit("sicbo:bet_confirmed", res);
      };
      try {
        if (rateBlocked(socket._rate)) {
          return respond({ ok: false, reason: "RATE_LIMITED" });
        }
        const { betType, amount, actionId } = payload || {};
        if (duplicateAction(socket._rate, actionId)) {
          return respond({ ok: false, reason: "DUPLICATE" });
        }

        const round = await roundManager.getCurrentBettingRound();
        if (!round) return respond({ ok: false, reason: "BETTING_CLOSED" });

        const result = await walletAdapter.placeBet({
          userId: socket.userId,
          roundId: round.roundId,
          betType,
          amount,
        });
        respond({
          ok: true,
          roundId: round.roundId,
          betType: result.betType,
          amount: result.amount,
          totalOnZone: result.totalOnZone,
          roundStake: result.roundStake,
          balance: result.balance,
        });
      } catch (err) {
        respond({ ok: false, reason: err?.code || "BET_FAILED" });
        if (!err?.code) {
          logger.error("sicbo_place_bet_failed", {
            userId: socket.userId,
            reason: err?.message,
          });
        }
      }
    });

    socket.on("sicbo:leave", () => {
      socket.leave(ROOM());
      socket.leave(userRoom(socket.userId));
    });

    socket.on("disconnect", () => {
      // Rooms auto-cleaned by socket.io; bets persist in Mongo for reconnect.
    });
  });

  startSicboEngine({ nsp, redis });
  logger.info("sicbo_namespace_ready");
  return nsp;
}

module.exports = { initSicbo };
