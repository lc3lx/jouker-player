/**
 * Choosing partners before the deal — Tarneeb 41 and تركس شركة.
 *
 * Both games are played by two pairs, and both hardcode the pairing as the
 * facing seats: teams are `seatIndex % 2` everywhere — the scoring, the
 * `partnerSeat`/`opponentSeats` helpers, the bot's "do not overtake my partner"
 * rule, and settlement's `i % 2 === winnerTeam`. So the pairing is not a field
 * that can be set; it *is* the seating order.
 *
 * That makes the mechanic simple and the implementation safe: one player names
 * the partner they want, that player accepts, and the four seats are then
 * arranged so the two of them face each other. The remaining two are partners
 * by what is left over — which is what the table expects anyway, and why one
 * choice plus one acceptance settles the whole table.
 *
 * The rearranging **must** happen before any cards are dealt. Afterwards, seat
 * indices own the hands, the scores, the trick order and the Mongo seat rows;
 * moving one then would be a data-loss bug, not a UI change. Every entry point
 * here is therefore pre-deal only.
 */
const timerManager = require("./TimerManager");
const {
  PARTNER_CHOOSE_MS,
  PARTNER_ACCEPT_MS,
  remainingWaitSeconds,
} = require("../utils/cardTableTimings");

const PHASE = Object.freeze({
  /** Waiting for the chooser to name someone. */
  CHOOSING: "choosing",
  /** Waiting for the named player to accept. */
  AWAITING_ACCEPT: "awaiting_accept",
  /** Pairs are fixed; the deal can begin. */
  SETTLED: "settled",
});

/**
 * Reorder `players` so `chooserSeat` and `partnerSeat` face each other.
 *
 * Returns a NEW array in seat order with `seatIndex` reassigned. The chooser
 * keeps the front of the table and their partner lands opposite; the other two
 * fill the remaining facing pair, so they are partners without having to
 * choose. Seat order becomes [chooser, other, partner, other].
 *
 * **`chair` moves with `seatIndex`, and it has to.** The chair is what the
 * player picked on the felt and what survives a roster rebuild: both engines
 * re-sort by it (`reindexByChair`, `syncLobbyFromTable`), and `startGame` does
 * so on its way to the deal. Reassigning only `seatIndex` meant the very next
 * re-sort put everyone back where they had been sitting — two players who chose
 * each other and accepted ended up **adjacent, each partnered with a bot**.
 * Agreeing to a partner is agreeing to move opposite them, so the chair is part
 * of what moves.
 *
 * @param {Array<object>} players seat-ordered roster (length 4)
 * @param {number} chooserSeat
 * @param {number} partnerSeat
 * @returns {Array<object>} the same player objects, reordered and re-indexed
 */
function arrangeSeatsForPartners(players, chooserSeat, partnerSeat) {
  if (!Array.isArray(players) || players.length !== 4) return players;
  if (chooserSeat === partnerSeat) return players;
  if (!players[chooserSeat] || !players[partnerSeat]) return players;

  const others = [0, 1, 2, 3].filter(
    (i) => i !== chooserSeat && i !== partnerSeat
  );
  const ordered = [
    players[chooserSeat],
    players[others[0]],
    players[partnerSeat],
    players[others[1]],
  ];
  ordered.forEach((p, i) => {
    if (!p) return;
    p.seatIndex = i;
    p.chair = i;
  });
  return ordered;
}

/**
 * Runs the choose-and-accept exchange for one table.
 *
 * The host engine supplies the roster and three callbacks; this owns only the
 * phase, the timers and the arithmetic. It never touches cards.
 */
class PartnerSelection {
  /**
   * @param {object} opts
   * @param {string} opts.roomId               timer namespace
   * @param {() => Array<object>} opts.getPlayers  current seat-ordered roster
   * @param {(players: Array<object>) => void} opts.onSeatsArranged
   *   hand back the reordered roster; the engine installs it
   * @param {() => void} opts.onSettled        pairs are fixed — deal now
   * @param {(payload: object) => void} [opts.onUpdate] broadcast hook
   */
  constructor({ roomId, getPlayers, onSeatsArranged, onSettled, onUpdate }) {
    this.roomId = roomId;
    this.getPlayers = getPlayers;
    this.onSeatsArranged = onSeatsArranged;
    this.onSettled = onSettled;
    this.onUpdate = typeof onUpdate === "function" ? onUpdate : () => {};

    this.active = false;
    this.phase = null;
    this.chooserSeat = null;
    this.pendingPartnerSeat = null;
    /** Seats that already turned this chooser down — never offered twice. */
    this.declinedSeats = new Set();
    /** Who turned the chooser down last, and why — shown back to the chooser. */
    this.lastDeclinedName = null;
    this.lastDeclineReason = null;
    this.deadline = null;
    this._timer = null;
  }

  /** True once the pairs are fixed and the deal may start. */
  get isSettled() {
    return this.phase === PHASE.SETTLED;
  }

  remainingSeconds() {
    return remainingWaitSeconds(this.deadline);
  }

  /**
   * Seats that may still be named. Excludes the chooser and anyone who has
   * already declined, so the exchange always terminates.
   */
  candidateSeats() {
    const players = this.getPlayers() || [];
    const out = [];
    for (let i = 0; i < players.length; i += 1) {
      if (i === this.chooserSeat) continue;
      if (this.declinedSeats.has(i)) continue;
      if (players[i]) out.push(i);
    }
    return out;
  }

  /**
   * Begin. The chooser is the first human at the table — a bot would only be
   * choosing on a player's behalf, which is not what anyone wants to watch.
   * A table of only bots settles instantly on the seating it already has.
   *
   * @returns {boolean} true when a real exchange started
   */
  begin() {
    const players = this.getPlayers() || [];
    if (players.length !== 4) return false;

    this.active = true;
    this.declinedSeats = new Set();
    this.lastDeclinedName = null;
    this.lastDeclineReason = null;

    const humanSeat = players.findIndex((p) => p && !p.isBot && p.userId);
    if (humanSeat < 0) {
      // Nobody to ask. Keep the seating as dealt and move on.
      this._settle();
      return false;
    }

    this.chooserSeat = humanSeat;
    this._enterChoosing();
    return true;
  }

  _enterChoosing() {
    this.phase = PHASE.CHOOSING;
    this.pendingPartnerSeat = null;

    const candidates = this.candidateSeats();
    if (candidates.length === 0) {
      // Everyone turned this chooser down; the table keeps its seating.
      this._settle();
      return;
    }

    this._arm(PARTNER_CHOOSE_MS, () => {
      // No answer — take the first candidate rather than stalling the table.
      const fallback = this.candidateSeats()[0];
      if (fallback == null) {
        this._settle();
        return;
      }
      this._acceptPair(this.chooserSeat, fallback, "chooser_timeout");
    });
    this._emit();
  }

  /**
   * The chooser names a partner.
   * @returns {{ ok: boolean, reason?: string }}
   */
  choose(seatIndex, byUserId) {
    if (!this.active || this.phase !== PHASE.CHOOSING) {
      return { ok: false, reason: "not_choosing" };
    }
    const players = this.getPlayers() || [];
    const chooser = players[this.chooserSeat];
    if (!chooser || String(chooser.userId) !== String(byUserId)) {
      return { ok: false, reason: "not_the_chooser" };
    }
    if (!this.candidateSeats().includes(seatIndex)) {
      return { ok: false, reason: "invalid_partner" };
    }

    this.pendingPartnerSeat = seatIndex;
    this.phase = PHASE.AWAITING_ACCEPT;
    // A fresh question: the previous refusal is no longer what is happening.
    this.lastDeclinedName = null;
    this.lastDeclineReason = null;

    const target = players[seatIndex];
    if (target && target.isBot) {
      // A bot has no opinion worth waiting on.
      this._acceptPair(this.chooserSeat, seatIndex, "bot_accept");
      return { ok: true };
    }

    this._arm(PARTNER_ACCEPT_MS, () => {
      // Silence is not consent, but it cannot hold the table either: treat it
      // as a decline and let the chooser try someone else.
      this._declineCurrent("accept_timeout");
    });
    this._emit();
    return { ok: true };
  }

  /**
   * The named player answers.
   * @returns {{ ok: boolean, reason?: string }}
   */
  respond(accepted, byUserId) {
    if (!this.active || this.phase !== PHASE.AWAITING_ACCEPT) {
      return { ok: false, reason: "not_awaiting" };
    }
    const players = this.getPlayers() || [];
    const target = players[this.pendingPartnerSeat];
    if (!target || String(target.userId) !== String(byUserId)) {
      return { ok: false, reason: "not_the_invited" };
    }

    if (accepted) {
      this._acceptPair(this.chooserSeat, this.pendingPartnerSeat, "accepted");
    } else {
      this._declineCurrent("declined");
    }
    return { ok: true };
  }

  _declineCurrent(reason) {
    if (this.pendingPartnerSeat != null) {
      this.declinedSeats.add(this.pendingPartnerSeat);
      // Kept for the payload so the chooser is told *who* said no and why,
      // rather than the panel silently resetting to the list again.
      const players = this.getPlayers() || [];
      this.lastDeclinedName =
        players[this.pendingPartnerSeat]?.displayName || null;
    }
    this.lastDeclineReason = reason;
    this._enterChoosing();
  }

  _acceptPair(chooserSeat, partnerSeat, reason) {
    this._clearTimer();
    const players = this.getPlayers() || [];
    const arranged = arrangeSeatsForPartners(players, chooserSeat, partnerSeat);
    this.onSeatsArranged(arranged);
    this.settledReason = reason;
    this._settle();
  }

  _settle() {
    this._clearTimer();
    this.phase = PHASE.SETTLED;
    this.active = false;
    this.deadline = null;
    this._emit();
    this.onSettled();
  }

  /**
   * Public view of the exchange for the table state / socket payloads.
   *
   * This goes out as one broadcast to the whole room, so it cannot be masked
   * per viewer. Each client has to work out from it whether *it* is the one
   * choosing or the one being asked — and it cannot do that from a seat index
   * alone, because seats are renumbered under the client (`reindexByChair`
   * when bots fill an empty chair) with nothing telling it. So the payload
   * carries **who**, not just where: the userIds decide, and the roster lets a
   * client find its own current seat again.
   */
  toPayload() {
    const players = this.getPlayers() || [];
    const nameOf = (i) => players[i]?.displayName || `لاعب ${i + 1}`;
    const idOf = (i) => {
      const p = players[i];
      if (!p || p.isBot) return null;
      return p.userId ? String(p.userId) : null;
    };
    return {
      phase: this.phase,
      chooserSeat: this.chooserSeat,
      chooserName: this.chooserSeat == null ? null : nameOf(this.chooserSeat),
      chooserUserId: this.chooserSeat == null ? null : idOf(this.chooserSeat),
      pendingPartnerSeat: this.pendingPartnerSeat,
      pendingPartnerName:
        this.pendingPartnerSeat == null ? null : nameOf(this.pendingPartnerSeat),
      pendingPartnerUserId:
        this.pendingPartnerSeat == null ? null : idOf(this.pendingPartnerSeat),
      candidateSeats: this.phase === PHASE.CHOOSING ? this.candidateSeats() : [],
      // Seat-ordered, so a client can locate itself by userId after a renumber.
      seats: players.map((p, i) => ({
        seatIndex: i,
        userId: idOf(i),
        displayName: nameOf(i),
        isBot: !!p?.isBot,
      })),
      // Surfaced only while the chooser is picking again after a refusal.
      lastDeclinedName:
        this.phase === PHASE.CHOOSING ? this.lastDeclinedName : null,
      lastDeclineReason:
        this.phase === PHASE.CHOOSING ? this.lastDeclineReason : null,
      remainingSeconds: this.remainingSeconds(),
      // After settling, facing seats are partners — teams are 0+2 and 1+3.
      teams: this.isSettled ? [[0, 2], [1, 3]] : null,
    };
  }

  _arm(ms, fn) {
    this._clearTimer();
    this.deadline = Date.now() + ms;
    this._timer = timerManager.schedule(this.roomId, "partner_selection", ms, () => {
      this._timer = null;
      fn();
    });
  }

  _clearTimer() {
    if (this._timer != null) {
      if (!timerManager.clear(this._timer)) clearTimeout(this._timer);
      this._timer = null;
    }
    this.deadline = null;
  }

  _emit() {
    try {
      this.onUpdate(this.toPayload());
    } catch (_) {
      /* a broadcast failure must not stall the exchange */
    }
  }

  destroy() {
    this._clearTimer();
    this.active = false;
  }
}

module.exports = { PartnerSelection, arrangeSeatsForPartners, PHASE };
