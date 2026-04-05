/**
 * Tarneeb Syrian 41 — table-based game (Mongo seats + bots).
 * Play order between tricks: counter-clockwise (index + 3) % 4.
 */
const BaseGame = require("../base/BaseGame");
const { newDeck, shuffle } = require("../utils/cards");
const rules = require("./tarneeb41.rules");

class Tarneeb41Game extends BaseGame {
  constructor(roomId, options = {}) {
    super(roomId, "tarneeb41", options);
    this.maxPlayers = 4;
    this.hands = [[], [], [], []];
    this.dealerIndex = -1;
    this.revealedCard = null;
    this.trump = null;
    this.declaredBids = [null, null, null, null];
    this.tricksThisRound = [0, 0, 0, 0];
    this.playerScores = [0, 0, 0, 0];
    this.trick = [];
    this.ledSuit = null;
    this.currentPlayerIndex = 0;
    this.trickLeader = 0;
    this.roundNumber = 0;
    this.botInterval = null;
    this.state = "waiting";
  }

  getRequiredPlayers() {
    return 4;
  }

  nextSeatCCW(i) {
    return (i + 3) % 4;
  }

  nextSeatCW(i) {
    return (i + 1) % 4;
  }

  syncLobbyFromTable(tableDoc, resolveSocket) {
    if (this.hands[0] && this.hands[0].length > 0) {
      for (const p of this.players) {
        if (!p.isBot) {
          const sid = resolveSocket(String(p.userId));
          if (sid) p.socketId = sid;
        }
      }
      return;
    }

    this.players = [];
    for (let i = 0; i < tableDoc.seats.length; i++) {
      const seat = tableDoc.seats[i];
      const uid = seat.user && seat.user._id ? seat.user._id : seat.user;
      const uidStr = String(uid);
      let nm = `لاعب ${i + 1}`;
      if (seat.user && typeof seat.user === "object" && seat.user.name) {
        nm = String(seat.user.name);
      }
      this.players.push({
        userId: uid,
        socketId: resolveSocket(uidStr) || null,
        seatIndex: this.players.length,
        isBot: false,
        displayName: nm,
        chips: Number(seat.chips) || 0,
      });
    }
    let bi = 0;
    while (this.players.length < 4) {
      const botId = `bot_${Date.now()}_${bi}_${Math.random().toString(36).substr(2, 9)}`;
      bi += 1;
      this.players.push({
        userId: botId,
        socketId: null,
        seatIndex: this.players.length,
        isBot: true,
        displayName: "بوت",
        chips: 0,
      });
    }
  }

  startGame() {
    while (this.players.length < 4) {
      const botId = `bot_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      this.players.push({
        userId: botId,
        socketId: null,
        seatIndex: this.players.length,
        isBot: true,
        displayName: "بوت",
        chips: 0,
      });
    }
    this.dealRound(true);
    this.startBotTimer();
    return true;
  }

  dealRound(rotateDealer) {
    if (rotateDealer) {
      this.dealerIndex = this.dealerIndex < 0 ? 0 : (this.dealerIndex + 1) % 4;
    } else if (this.dealerIndex < 0) {
      this.dealerIndex = 0;
    }

    const deck = shuffle(newDeck());
    this.hands = [[], [], [], []];

    // Deal starts from the player on the right of the dealer.
    // This also makes the "last dealt card" (revealedCard) shift correctly when dealer rotates.
    const startSeat = (this.dealerIndex + 1) % 4;
    for (let i = 0; i < 52; i += 1) {
      this.hands[(startSeat + i) % 4].push(deck[i]);
    }
    const lastSeat = (startSeat + 51) % 4;
    const h = this.hands[lastSeat];
    const lastCard = { ...h[h.length - 1] };
    this.revealedCard = lastCard;
    this.trump = rules.oppositeColorSuit(lastCard.suit);
    this.declaredBids = [null, null, null, null];
    this.tricksThisRound = [0, 0, 0, 0];
    this.trick = [];
    this.ledSuit = null;
    this.state = "bidding_syrian";
    this.currentPlayerIndex = (this.dealerIndex + 1) % 4;
    this.trickLeader = this.currentPlayerIndex;
  }

  startBotTimer() {
    if (this.botInterval) clearInterval(this.botInterval);
    this.botInterval = setInterval(() => this.checkBotTurn(), 1500);
  }

  checkBotTurn() {
    if (this.state === "game_end" || this.state === "waiting") return;
    const idx = this.currentPlayerIndex;
    const p = this.players[idx];
    if (!p || !p.isBot) return;

    if (this.state === "bidding_syrian") {
      const v = 3 + Math.floor(Math.random() * 5);
      this.applyMove(idx, "tarneeb41_declare", { value: v });
    } else if (this.state === "playing") {
      const hand = this.hands[idx];
      const valid = rules.getValidCards(hand, this.ledSuit);
      if (valid.length === 0) return;
      const card = valid[Math.floor(Math.random() * valid.length)];
      this.applyMove(idx, "play_card", {
        card: { suit: rules.toApiSuit(card.suit), rank: rules.toApiRank(card.rank) },
      });
    }
  }

  allDeclared() {
    return this.declaredBids.every((b) => b !== null);
  }

  findNextUndeclared(from) {
    let c = this.nextSeatCW(from);
    for (let n = 0; n < 4; n += 1) {
      if (this.declaredBids[c] === null) return c;
      c = this.nextSeatCW(c);
    }
    return from;
  }

  applyMove(playerIndex, action, payload) {
    if (action === "tarneeb41_declare") {
      if (this.state !== "bidding_syrian") return { success: false, reason: "not_bidding" };
      if (this.currentPlayerIndex !== playerIndex) return { success: false, reason: "not_your_turn" };
      if (this.declaredBids[playerIndex] !== null) return { success: false, reason: "already_declared" };
      const vr = rules.validateDeclare(payload && payload.value);
      if (!vr.valid) return { success: false, reason: "invalid_declare" };
      this.declaredBids[playerIndex] = vr.v;

      if (!this.allDeclared()) {
        this.currentPlayerIndex = this.findNextUndeclared(this.currentPlayerIndex);
        return { success: true };
      }

      const sum = this.declaredBids.reduce((a, b) => a + b, 0);
      if (sum < rules.SUM_MIN_TO_PLAY) {
        this.dealRound(false);
        return { success: true, redeal: true };
      }

      this.state = "playing";
      this.trickLeader = (this.dealerIndex + 1) % 4;
      this.currentPlayerIndex = this.trickLeader;
      this.trick = [];
      this.ledSuit = null;
      return { success: true };
    }

    if (action === "play_card") {
      if (this.state !== "playing") return { success: false, reason: "not_playing" };
      if (this.currentPlayerIndex !== playerIndex) return { success: false, reason: "not_your_turn" };
      const { card } = payload || {};
      const vr = rules.validateCardPlay(this.hands[playerIndex], card, this.ledSuit, this.trump);
      if (!vr.valid) return { success: false, reason: vr.reason || "invalid_card" };
      const c = vr.card;
      const hi = this.hands[playerIndex].findIndex((x) => x.suit === c.suit && x.rank === c.rank);
      if (hi < 0) return { success: false, reason: "card_not_in_hand" };
      this.hands[playerIndex].splice(hi, 1);
      this.trick.push({ card: c, playerIndex });
      if (this.trick.length === 1) this.ledSuit = c.suit;

      if (this.trick.length < 4) {
        this.currentPlayerIndex = this.nextSeatCCW(this.currentPlayerIndex);
        return { success: true };
      }

      const winner = rules.winningCardInTrick(this.trick, this.ledSuit, this.trump);
      if (!winner) return { success: false, reason: "trick_error" };
      this.tricksThisRound[winner.playerIndex] += 1;
      this.trickLeader = winner.playerIndex;
      this.currentPlayerIndex = winner.playerIndex;
      this.trick = [];
      this.ledSuit = null;

      if (this.hands[0].length === 0) {
        this.endRound();
      }
      return { success: true, trickWinner: winner.playerIndex };
    }

    if (action === "next_round") {
      if (this.state === "game_end") return { success: false };
      if (this.state !== "round_end") return { success: false, reason: "not_round_end" };
      this.dealRound(true);
      return { success: true };
    }

    return { success: false, reason: "unknown_action" };
  }

  /** Call from socket when any seated player confirms next deal. */
  advanceNextRound() {
    return this.applyMove(0, "next_round", {}).success;
  }

  endRound() {
    rules.applyRoundScores(this.declaredBids, this.tricksThisRound, this.playerScores);
    this.roundNumber += 1;
    const end = rules.checkGameEnd(this.playerScores);
    if (end.ended) {
      this.state = "game_end";
      if (this.botInterval) {
        clearInterval(this.botInterval);
        this.botInterval = null;
      }
    } else {
      this.state = "round_end";
    }
  }

  isGameFinished() {
    return this.state === "game_end";
  }

  getRoundResult() {
    return {
      declaredBids: [...this.declaredBids],
      tricksThisRound: [...this.tricksThisRound],
      playerScores: [...this.playerScores],
    };
  }

  getGameResult() {
    if (this.state !== "game_end") return null;
    const end = rules.checkGameEnd(this.playerScores);
    return {
      winnerTeam: end.winnerTeam,
      playerScores: [...this.playerScores],
    };
  }

  _cardToApi(c) {
    if (!c) return null;
    return {
      suit: rules.toApiSuit(c.suit),
      rank: rules.toApiRank(c.rank),
    };
  }

  getGameState(forPlayerIndex) {
    const hands = this.hands.map((h, i) =>
      i === forPlayerIndex ? h.map((c) => this._cardToApi(c)) : h.map(() => null)
    );
    const handSizes = this.hands.map((h) => h.length);
    let validCards = [];
    if (this.state === "playing" && forPlayerIndex >= 0) {
      validCards = rules
        .getValidCards(this.hands[forPlayerIndex], this.ledSuit)
        .map((c) => this._cardToApi(c));
    }

    const seatsPublic = this.players.map((p, idx) => ({
      seatIndex: idx,
      displayName: p.displayName || (p.isBot ? "بوت" : `لاعب ${idx + 1}`),
      isBot: !!p.isBot,
      chips: p.chips || 0,
    }));

    return {
      state: this.state,
      gameType: this.gameType,
      hands,
      handSizes,
      trick: this.trick.map((t) => ({
        playerIndex: t.playerIndex,
        card: this._cardToApi(t.card),
      })),
      ledSuit: this.ledSuit ? rules.toApiSuit(this.ledSuit) : null,
      trump: this.trump ? rules.toApiSuit(this.trump) : null,
      revealedCard: this._cardToApi(this.revealedCard),
      declaredBids: [...this.declaredBids],
      tricksThisRound: [...this.tricksThisRound],
      playerScores: [...this.playerScores],
      dealerIndex: this.dealerIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      trickLeader: this.trickLeader,
      roundNumber: this.roundNumber,
      validCards,
      seatsPublic,
    };
  }
}

module.exports = Tarneeb41Game;
