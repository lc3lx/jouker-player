const { toSafeInt } = require("../utils/pokerTableStatus");

const RANK_LABEL = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  T: "10",
  J: "Jack",
  Q: "Queen",
  K: "King",
  A: "Ace",
};

const SUIT_LABEL = { c: "Clubs", d: "Diamonds", h: "Hearts", s: "Spades" };

function cardLabel(code) {
  if (!code || typeof code !== "string" || code.length < 2) return String(code || "");
  const r = RANK_LABEL[code[0]] || code[0];
  const s = SUIT_LABEL[code[1]] || code[1];
  return `${r} of ${s}`;
}

function formatCards(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return "[]";
  return `[${cards.map((c) => cardLabel(c)).join(", ")}]`;
}

function resolvePlayerName(seats, playerId, seatIndex) {
  if (seatIndex != null && seats[seatIndex]) {
    return seats[seatIndex].name || `Seat ${seatIndex}`;
  }
  const row = seats.find((s) => String(s.userId) === String(playerId));
  if (row) return row.name || String(playerId);
  if (typeof playerId === "string" && playerId.startsWith("bot:")) return "Bot";
  return playerId ? String(playerId) : "Unknown";
}

/**
 * Build chronological human-readable audit log for support / fraud analytics.
 * @param {Array} actions — currentHandActions
 * @param {Array} seats — engine seats at hand end
 * @param {string[]} community
 */
function buildHandAuditLog(actions, seats, community) {
  const log = [];
  const seatList = Array.isArray(seats) ? seats : [];
  const acts = Array.isArray(actions) ? actions : [];

  for (const a of acts) {
    if (!a || typeof a !== "object") continue;
    const ts = toSafeInt(a.ts, Date.now());
    const round = String(a.round || "");
    const type = String(a.type || "").toLowerCase();
    const name = resolvePlayerName(seatList, a.playerId, a.seatIndex);
    const amt = toSafeInt(a.amount, 0);

    let message = null;

    if (type === "blind") {
      const blind = a.blind === "SB" ? "Small Blind" : a.blind === "BB" ? "Big Blind" : "Blind";
      message = `${name}: ${blind} ${amt}`;
    } else if (type === "fold") {
      message = `${name}: Fold`;
    } else if (type === "check") {
      message = `${name}: Check`;
    } else if (type === "call") {
      message = amt > 0 ? `${name}: Call ${amt}` : `${name}: Check`;
    } else if (type === "raise") {
      message = `${name}: Raise ${amt}`;
    } else if (type === "timeout_fold") {
      message = `${name}: Auto-Fold (timeout)`;
    } else if (type === "timeout_call") {
      message = `${name}: Auto-Check (timeout)`;
    } else if (type === "street") {
      const street = String(a.street || "");
      if (street === "flop" && Array.isArray(community) && community.length >= 3) {
        message = `Flop Dealt: ${formatCards(community.slice(0, 3))}`;
      } else if (street === "turn" && community.length >= 4) {
        message = `Turn Dealt: ${cardLabel(community[3])}`;
      } else if (street === "river" && community.length >= 5) {
        message = `River Dealt: ${cardLabel(community[4])}`;
      } else if (street === "showdown") {
        message = "Showdown";
      } else {
        message = `Street: ${street}`;
      }
    }

    if (!message) continue;

    log.push({
      ts,
      round,
      type,
      playerId: a.playerId || null,
      seatIndex: a.seatIndex != null ? toSafeInt(a.seatIndex, -1) : null,
      amount: amt || null,
      message,
    });
  }

  return log;
}

module.exports = { buildHandAuditLog, cardLabel, formatCards };
