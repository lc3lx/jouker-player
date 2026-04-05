/**
 * TarneebGame - full game logic for Tarneeb (طرنيب).
 * 4 players, teams 0+2 vs 1+3. Bidding 7-13, trump, follow suit.
 */
const BaseGame = require("../base/BaseGame");
const { newDeck, shuffle, winningCardInTrick } = require("../utils/cards");
const {
  getTeam,
  validateBid,
  validateCardPlay,
  getValidCards,
  MIN_BID,
  MAX_BID,
  TARGET_SCORE,
  SUITS,
} = require("./tarneeb.rules");

class TarneebGame extends BaseGame {
  constructor(roomId, options = {}) {
    super(roomId, "tarneeb", options);
    this.maxPlayers = 4;
    this.hands = [[], [], [], []]; // cards per seat
    this.dealerIndex = -1; // -1 حتى يصبح أول ديلر = 0 بعد (dealerIndex+1)%4 في deal
    this.currentPlayerIndex = 0;
    this.trump = null;
    this.declarerIndex = null; // bidder who chose trump
    this.bidValue = null;
    this.bids = [null, null, null, null]; // null=not bid yet, -1=passed, 7-13=bid
    this.biddingComplete = false;
    this.trick = []; // [{ card, playerIndex }]
    this.trickLeader = 0;
    this.ledSuit = null;
    this.teamScores = [0, 0]; // team 0 (0,2), team 1 (1,3)
    this.roundTricks = [0, 0]; // tricks won this round per team
    this.roundNumber = 0;
  }

  getRequiredPlayers() {
    return 4;
  }

  /** Start game when 4 players joined */
  startGame() {
    if (this.players.length !== 4) return false;
    this.state = "dealing";
    this.deal();
    return true;
  }

  /**
   * إعادة التوزيع عند مرور الجميع - يبقى نفس الموزّع (لا تدوير للديلر)
   */
  redeal() {
    const deck = shuffle(newDeck());
    this.hands = [[], [], [], []];
    for (let i = 0; i < 52; i += 1) {
      this.hands[i % 4].push(deck[i]);
    }
    this.currentPlayerIndex = (this.dealerIndex + 1) % 4;
    this.bids = [null, null, null, null];
    this.biddingComplete = false;
    this.trump = null;
    this.declarerIndex = null;
    this.bidValue = null;
    this.trick = [];
    this.ledSuit = null;
    this.trickLeader = 0;
    this.roundTricks = [0, 0];
    this.state = "bidding";
    // dealerIndex لا يتغير - نفس الموزّع
  }

  deal() {
    // تدوير الديلر: أول جولة 0، ثم 1، 2، 3، 0...
    this.dealerIndex = (this.dealerIndex + 1) % 4;
    const deck = shuffle(newDeck());
    this.hands = [[], [], [], []];
    for (let i = 0; i < 52; i += 1) {
      this.hands[i % 4].push(deck[i]);
    }
    this.currentPlayerIndex = (this.dealerIndex + 1) % 4; // first bidder: right of dealer
    this.bids = [null, null, null, null];
    this.biddingComplete = false;
    this.trump = null;
    this.declarerIndex = null;
    this.bidValue = null;
    this.trick = [];
    this.ledSuit = null;
    this.trickLeader = 0;
    this.roundTricks = [0, 0];
    this.state = "bidding";
  }

  /**
   * التحقق من صحة الحركة - حماية سيرفر: لا ورقة لا يملكها، لا لون خاطئ، لا حركة في غير الدور
   */
  validateMove(playerIndex, action, payload) {
    if (action === "bid") {
      if (this.bids[playerIndex] !== null) return { valid: false, reason: "already_bid_or_passed" };
      if (this.currentPlayerIndex !== playerIndex) return { valid: false, reason: "not_your_turn" };
      if (this.state !== "bidding") return { valid: false, reason: "not_bidding" };
      const { value } = payload || {};
      const isPass = value === null || value === undefined || value === "pass";
      if (isPass && this.bidValue == null) return { valid: false, reason: "cannot_pass_without_bid" };
      const res = validateBid(this.bidValue, value);
      if (!res.valid) return { valid: false, reason: "invalid_bid" };
      return { valid: true };
    }
    if (action === "choose_trump") {
      const { trump } = payload || {};
      if (!trump || !SUITS.includes(trump)) return { valid: false, reason: "invalid_trump" };
      if (this.state !== "choosing_trump") return { valid: false, reason: "not_choosing_trump" };
      if (playerIndex !== this.declarerIndex) return { valid: false, reason: "only_declarer_chooses" };
      return { valid: true };
    }
    if (action === "play_card") {
      const { card } = payload || {};
      if (!card) return { valid: false, reason: "card_required" };
      if (this.currentPlayerIndex !== playerIndex) return { valid: false, reason: "not_your_turn" };
      if (this.state !== "playing") return { valid: false, reason: "not_playing" };
      const res = validateCardPlay(
        this.hands[playerIndex],
        { suit: card.suit, rank: card.rank },
        this.ledSuit,
        this.trump
      );
      if (!res.valid) return { valid: false, reason: res.reason || "invalid_card" };
      return { valid: true };
    }
    return { valid: false, reason: "unknown_action" };
  }

  applyMove(playerIndex, action, payload) {
    const check = this.validateMove(playerIndex, action, payload);
    if (!check.valid) return { success: false, reason: check.reason };

    if (action === "bid") {
      const { value } = payload || {};
      const res = validateBid(this.bidValue, value);
      if (res.pass) {
        this.bids[playerIndex] = -1;
      } else {
        this.bidValue = res.value;
        this.bids[playerIndex] = res.value;
      }
      this.advanceBidding();
      return { success: true };
    }
    if (action === "play_card") {
      const { card } = payload || {};
      const c = { suit: card.suit, rank: card.rank };
      const idx = this.hands[playerIndex].findIndex((x) => x.suit === c.suit && x.rank === c.rank);
      if (idx < 0) return { success: false, reason: "card_not_in_hand" };
      this.hands[playerIndex].splice(idx, 1);
      this.trick.push({ card: c, playerIndex });
      if (this.trick.length === 1) this.ledSuit = c.suit;
      this.advancePlaying();
      return { success: true };
    }
    if (action === "choose_trump") {
      const { trump } = payload || {};
      this.trump = trump;
      this.state = "playing";
      this.trick = [];
      this.ledSuit = null;
      this.trickLeader = (this.dealerIndex + 1) % 4;
      this.currentPlayerIndex = this.trickLeader;
      return { success: true };
    }
    return { success: false, reason: "unknown_action" };
  }

  /**
   * اللاعب التالي - أثناء اللعب: ترتيب ثابت (index+1)%4 فقط.
   * أثناء المزايدة: تخطي من مرّ (bids==-1).
   */
  nextActivePlayer(index) {
    if (this.state !== "bidding") {
      return (index + 1) % 4;
    }
    let next = (index + 1) % 4;
    while (this.bids[next] === -1) {
      next = (next + 1) % 4;
      if (next === index) break;
    }
    return next;
  }

  /**
   * تقدم المزايدة: مرور الجميع → إعادة توزيع. 3 مروا → الفائز صاحب أعلى bid.
   */
  advanceBidding() {
    const passed = this.bids.filter((b) => b === -1).length;
    if (passed === 4) {
      this.redeal();
      return;
    }
    if (passed === 3) {
      let highestBid = MIN_BID - 1;
      let declarer = -1;
      for (let i = 0; i < 4; i += 1) {
        const b = this.bids[i];
        if (b >= MIN_BID && b <= MAX_BID && b > highestBid) {
          highestBid = b;
          declarer = i;
        }
      }
      if (declarer >= 0) {
        this.declarerIndex = declarer;
        this.bidValue = this.bids[declarer];
        this.biddingComplete = true;
        this.state = "choosing_trump";
        this.currentPlayerIndex = declarer;
      }
      return;
    }
    this.currentPlayerIndex = this.nextActivePlayer(this.currentPlayerIndex);
  }

  /** Wrapper: يمر عبر applyMove للحفاظ على واجهة chooseTrump */
  chooseTrump(declarerIndex, trump) {
    const result = this.applyMove(declarerIndex, "choose_trump", { trump });
    return result.success;
  }

  /**
   * تقدم اللعب: 4 أوراق → تحديد الفائز، الفائز يبدأ الأكلة التالية.
   */
  advancePlaying() {
    if (this.trick.length < 4) {
      this.currentPlayerIndex = this.nextActivePlayer(this.currentPlayerIndex);
      return;
    }
    const winner = winningCardInTrick(this.trick, this.ledSuit, this.trump);
    const team = getTeam(winner.playerIndex);
    this.roundTricks[team] += 1;
    this.trickLeader = winner.playerIndex;
    this.currentPlayerIndex = winner.playerIndex; // فائز الأكلة يبدأ التالية
    this.trick = [];
    this.ledSuit = null;

    if (this.hands[0].length === 0) {
      this.endRound();
    }
  }

  /**
   * احتساب النقاط: الفريق المعلن فقط يتأثر. حقق ≥ bid → +اللفات | فشل → -bid.
   */
  endRound() {
    const declTeam = getTeam(this.declarerIndex);
    const bid = this.bidValue;
    const made = this.roundTricks[declTeam];
    if (made >= bid) {
      this.teamScores[declTeam] += made;
    } else {
      this.teamScores[declTeam] -= bid;
    }

    this.roundNumber += 1;
    this.state = "round_end";

    if (this.teamScores[0] >= TARGET_SCORE || this.teamScores[1] >= TARGET_SCORE) {
      this.state = "game_end";
    }
  }

  /** Start next round (new deal) - لا يسمح إلا عند round_end */
  nextRound() {
    if (this.state === "game_end") return false;
    if (this.state !== "round_end") return false;
    this.deal();
    return true;
  }

  getGameState(forPlayerIndex) {
    const publicHands = this.hands.map((h, i) =>
      i === forPlayerIndex ? h : h.map(() => null)
    );
    const handSizes = this.hands.map((h) => h.length);
    const validCards = this.state === "playing" ? getValidCards(this.hands[forPlayerIndex], this.ledSuit) : [];
    return {
      state: this.state,
      roomId: this.roomId,
      gameType: this.gameType,
      hands: publicHands,
      handSizes,
      currentPlayerIndex: this.currentPlayerIndex,
      trick: this.trick,
      ledSuit: this.ledSuit,
      trump: this.trump,
      dealerIndex: this.dealerIndex,
      declarerIndex: this.declarerIndex,
      bidValue: this.bidValue,
      bids: this.bids,
      biddingComplete: this.biddingComplete,
      teamScores: this.teamScores,
      roundTricks: this.roundTricks,
      roundNumber: this.roundNumber,
      trickLeader: this.trickLeader,
      players: this.players.map((p) => ({ userId: p.userId, seatIndex: p.seatIndex })),
      validCards,
    };
  }

  getValidCards(playerIndex) {
    if (this.state !== "playing") return [];
    return getValidCards(this.hands[playerIndex], this.ledSuit);
  }

  isGameFinished() {
    return this.state === "game_end";
  }

  getRoundResult() {
    if (this.state !== "round_end" && this.state !== "game_end") return null;
    return {
      teamScores: this.teamScores,
      roundTricks: this.roundTricks,
      declarerTeam: getTeam(this.declarerIndex),
      bidValue: this.bidValue,
    };
  }

  getGameResult() {
    if (this.state !== "game_end") return null;
    const winner = this.teamScores[0] >= TARGET_SCORE ? 0 : 1;
    return {
      winnerTeam: winner,
      teamScores: this.teamScores,
    };
  }
}

module.exports = TarneebGame;
