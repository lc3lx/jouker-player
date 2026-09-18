/**
 * Picking partners before the deal — Tarneeb 41 and تركس شركة.
 *
 * One player names who they want to play with, that player accepts, and the
 * other two are partners by what is left over. One choice plus one acceptance
 * settles the whole table.
 *
 * The part that carries the risk is what "partnered" *means* here. Both games
 * hardcode teams as the facing seats — `seatIndex % 2` runs the scoring, the
 * partner/opponent helpers, the bots' "do not overtake my partner" rule and
 * settlement's `i % 2 === winnerTeam`. So accepting does not set a field, it
 * **reorders the seats**, and that is only safe before any cards exist.
 */
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PartnerSelection,
  arrangeSeatsForPartners,
  PHASE,
} = require("../engine/partnerSelection");
const TrixGame = require("../games/trix/TrixGame");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");

function roster(spec) {
  return spec.map((s, i) => ({
    userId: s.id,
    seatIndex: i,
    isBot: !!s.bot,
    displayName: s.id,
  }));
}

const FOUR_HUMANS = [
  { id: "a" },
  { id: "b" },
  { id: "c" },
  { id: "d" },
];

// ── the seating arithmetic ───────────────────────────────────────────────────

test("the chosen pair ends up facing each other", () => {
  const players = roster(FOUR_HUMANS);
  // Seat 0 picks its neighbour at seat 1 — the pair that is NOT already facing.
  const out = arrangeSeatsForPartners(players, 0, 1);

  assert.deepEqual(out.map((p) => p.userId), ["a", "c", "b", "d"]);
  assert.equal(out[0].userId, "a");
  assert.equal(out[2].userId, "b", "the partner sits opposite");
});

test("the other two become partners without choosing anything", () => {
  const out = arrangeSeatsForPartners(roster(FOUR_HUMANS), 0, 1);
  // Teams are the facing seats: 0+2 and 1+3.
  assert.deepEqual([out[0].userId, out[2].userId], ["a", "b"]);
  assert.deepEqual([out[1].userId, out[3].userId], ["c", "d"]);
});

test("seat indices are rewritten to match the new order", () => {
  const out = arrangeSeatsForPartners(roster(FOUR_HUMANS), 1, 3);
  out.forEach((p, i) => assert.equal(p.seatIndex, i));
});

test("a pair that already faces each other is left where it is", () => {
  const out = arrangeSeatsForPartners(roster(FOUR_HUMANS), 0, 2);
  assert.deepEqual(out.map((p) => p.userId), ["a", "b", "c", "d"]);
});

test("every chooser/partner combination lands opposite", () => {
  for (let chooser = 0; chooser < 4; chooser += 1) {
    for (let partner = 0; partner < 4; partner += 1) {
      if (chooser === partner) continue;
      const out = arrangeSeatsForPartners(roster(FOUR_HUMANS), chooser, partner);
      const chooserId = FOUR_HUMANS[chooser].id;
      const partnerId = FOUR_HUMANS[partner].id;
      const ci = out.findIndex((p) => p.userId === chooserId);
      const pi = out.findIndex((p) => p.userId === partnerId);
      assert.equal(
        (ci + 2) % 4,
        pi,
        `chooser ${chooser} + partner ${partner} must face each other`,
      );
      assert.equal(new Set(out.map((p) => p.userId)).size, 4, "nobody is lost");
    }
  }
});

test("a malformed roster is returned untouched rather than half-sorted", () => {
  const three = roster(FOUR_HUMANS.slice(0, 3));
  assert.equal(arrangeSeatsForPartners(three, 0, 1), three);
  const four = roster(FOUR_HUMANS);
  assert.equal(arrangeSeatsForPartners(four, 1, 1), four, "self-pick is a no-op");
});

// ── the exchange ─────────────────────────────────────────────────────────────

function mkExchange(spec = FOUR_HUMANS) {
  const players = { current: roster(spec) };
  const updates = [];
  let settled = 0;
  const sel = new PartnerSelection({
    roomId: `partner_test_${Math.random()}`,
    getPlayers: () => players.current,
    onSeatsArranged: (arranged) => {
      players.current = arranged;
    },
    onSettled: () => {
      settled += 1;
    },
    onUpdate: (p) => updates.push(p),
  });
  return {
    sel,
    updates,
    get players() {
      return players.current;
    },
    get settled() {
      return settled;
    },
  };
}

test("the first human is the one asked to choose", () => {
  const ex = mkExchange([{ id: "bot0", bot: true }, { id: "a" }, { id: "b" }, { id: "c" }]);
  try {
    assert.equal(ex.sel.begin(), true);
    assert.equal(ex.sel.chooserSeat, 1, "a bot never chooses for a player");
    assert.equal(ex.sel.phase, PHASE.CHOOSING);
  } finally {
    ex.sel.destroy();
  }
});

test("only the chooser may choose, and only a real candidate", () => {
  const ex = mkExchange();
  try {
    ex.sel.begin();
    assert.deepEqual(ex.sel.choose(2, "b"), { ok: false, reason: "not_the_chooser" });
    assert.deepEqual(ex.sel.choose(0, "a"), { ok: false, reason: "invalid_partner" });
    assert.deepEqual(ex.sel.choose(9, "a"), { ok: false, reason: "invalid_partner" });
    assert.deepEqual(ex.sel.choose(2, "a"), { ok: true });
  } finally {
    ex.sel.destroy();
  }
});

test("one choice plus one acceptance settles the table", () => {
  const ex = mkExchange();
  try {
    ex.sel.begin();
    ex.sel.choose(1, "a");
    assert.equal(ex.sel.phase, PHASE.AWAITING_ACCEPT);
    assert.equal(ex.settled, 0, "nothing is decided until they answer");

    assert.deepEqual(ex.sel.respond(true, "b"), { ok: true });

    assert.equal(ex.sel.isSettled, true);
    assert.equal(ex.settled, 1);
    assert.deepEqual(ex.players.map((p) => p.userId), ["a", "c", "b", "d"]);
  } finally {
    ex.sel.destroy();
  }
});

test("only the invited player may answer", () => {
  const ex = mkExchange();
  try {
    ex.sel.begin();
    ex.sel.choose(1, "a");
    assert.deepEqual(ex.sel.respond(true, "c"), { ok: false, reason: "not_the_invited" });
    assert.deepEqual(ex.sel.respond(true, "a"), { ok: false, reason: "not_the_invited" });
    assert.equal(ex.sel.isSettled, false);
  } finally {
    ex.sel.destroy();
  }
});

test("a decline sends the chooser back, minus whoever said no", () => {
  const ex = mkExchange();
  try {
    ex.sel.begin();
    ex.sel.choose(1, "a");
    ex.sel.respond(false, "b");

    assert.equal(ex.sel.phase, PHASE.CHOOSING);
    assert.deepEqual(
      ex.sel.candidateSeats(),
      [2, 3],
      "the same person is not offered twice — the exchange has to terminate",
    );
    assert.deepEqual(ex.sel.choose(1, "a"), { ok: false, reason: "invalid_partner" });
  } finally {
    ex.sel.destroy();
  }
});

test("if everyone declines, the table keeps the seating it has", () => {
  const ex = mkExchange();
  try {
    ex.sel.begin();
    for (const seat of [1, 2, 3]) {
      ex.sel.choose(seat, "a");
      ex.sel.respond(false, FOUR_HUMANS[seat].id);
    }
    assert.equal(ex.sel.isSettled, true);
    assert.deepEqual(ex.players.map((p) => p.userId), ["a", "b", "c", "d"]);
  } finally {
    ex.sel.destroy();
  }
});

test("a bot accepts at once — nobody waits on one", () => {
  const ex = mkExchange([{ id: "a" }, { id: "bot1", bot: true }, { id: "b" }, { id: "c" }]);
  try {
    ex.sel.begin();
    ex.sel.choose(1, "a");
    assert.equal(ex.sel.isSettled, true, "no accept step for a bot");
    assert.deepEqual(ex.players.map((p) => p.userId), ["a", "b", "bot1", "c"]);
  } finally {
    ex.sel.destroy();
  }
});

test("a table of only bots settles on the seating it already has", () => {
  const ex = mkExchange([
    { id: "b0", bot: true },
    { id: "b1", bot: true },
    { id: "b2", bot: true },
    { id: "b3", bot: true },
  ]);
  try {
    assert.equal(ex.sel.begin(), false, "there is nobody to ask");
    assert.equal(ex.sel.isSettled, true);
    assert.equal(ex.settled, 1, "the deal is not left hanging");
  } finally {
    ex.sel.destroy();
  }
});

test("the payload names both sides and the settled teams", () => {
  const ex = mkExchange();
  try {
    ex.sel.begin();
    const choosing = ex.sel.toPayload();
    assert.equal(choosing.phase, PHASE.CHOOSING);
    assert.equal(choosing.chooserSeat, 0);
    assert.equal(choosing.chooserName, "a");
    assert.deepEqual(choosing.candidateSeats, [1, 2, 3]);
    assert.equal(choosing.teams, null);

    ex.sel.choose(1, "a");
    const awaiting = ex.sel.toPayload();
    assert.equal(awaiting.phase, PHASE.AWAITING_ACCEPT);
    assert.equal(awaiting.pendingPartnerSeat, 1);
    assert.equal(awaiting.pendingPartnerName, "b");

    ex.sel.respond(true, "b");
    assert.deepEqual(ex.sel.toPayload().teams, [[0, 2], [1, 3]]);
  } finally {
    ex.sel.destroy();
  }
});

// ── wired into the engines ───────────────────────────────────────────────────

test("solo Trix never asks anyone to pick a partner", async () => {
  const game = new TrixGame("trix_solo_partner", { gameMode: "solo" });
  try {
    for (let i = 0; i < 4; i += 1) {
      game.players.push({
        userId: `u${i}`,
        seatIndex: i,
        isBot: false,
        displayName: `P${i}`,
        chips: 100,
      });
    }
    await game._dealOrChoosePartners();
    assert.equal(game.isChoosingPartners(), false, "اليهودية has no partners");
    assert.ok(game.gameState, "it just deals");
    game.clearBotTimer();
    game.clearTurnTimer();
  } finally {
    game.destroy();
  }
});

test("شركة Trix picks partners before it deals, and the seats follow", async () => {
  const game = new TrixGame("trix_pair_partner", { gameMode: "partnership" });
  try {
    for (let i = 0; i < 4; i += 1) {
      game.players.push({
        userId: `u${i}`,
        seatIndex: i,
        isBot: false,
        displayName: `P${i}`,
        chips: 100,
      });
    }
    await game._dealOrChoosePartners();

    assert.equal(game.isChoosingPartners(), true);
    assert.equal(game.gameState, null, "no cards until the pairs are settled");

    // u0 wants u1 — the neighbour, so the seats have to move.
    assert.deepEqual(game.choosePartner(1, "u0"), { ok: true });
    assert.deepEqual(game.respondToPartner(true, "u1"), { ok: true });
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(game.gameState, "the deal follows straight on");
    assert.deepEqual(
      game.players.map((p) => String(p.userId)),
      ["u0", "u2", "u1", "u3"],
    );
    assert.equal(
      game.teamScores().length,
      2,
      "and the engine's own team maths now describes the chosen pairs",
    );
    game.clearBotTimer();
    game.clearTurnTimer();
  } finally {
    game.destroy();
  }
});

test("Tarneeb picks partners before the start countdown", async () => {
  const game = new Tarneeb41Game("t41_partner", { mongoTableId: "t1" });
  try {
    for (let i = 0; i < 4; i += 1) {
      game.players.push({
        userId: `u${i}`,
        socketId: `s${i}`,
        seatIndex: i,
        isBot: false,
        displayName: `P${i}`,
        chips: 1000,
      });
    }
    game.startOrWaitForPlayers();
    assert.equal(game.isChoosingPartners(), true);
    assert.equal(game.state, "waiting", "no countdown until the pairs are set");

    game.choosePartner(3, "u0");
    game.respondToPartner(true, "u3");
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(
      game.players.map((p) => String(p.userId)),
      ["u0", "u1", "u3", "u2"],
    );
    assert.equal(game.state, "countdown");
  } finally {
    game.destroy();
  }
});

test("the exchange runs once per table, not once per round", async () => {
  const game = new Tarneeb41Game("t41_partner_once", { mongoTableId: "t1" });
  try {
    for (let i = 0; i < 4; i += 1) {
      game.players.push({
        userId: `u${i}`,
        socketId: `s${i}`,
        seatIndex: i,
        isBot: false,
        displayName: `P${i}`,
        chips: 1000,
      });
    }
    game.beginPartnerSelectionOrStart();
    game.choosePartner(1, "u0");
    game.respondToPartner(true, "u1");
    await new Promise((r) => setTimeout(r, 10));

    const order = game.players.map((p) => String(p.userId));
    // A second call must not re-open the question on an already paired table.
    game.state = "waiting";
    assert.equal(game.beginPartnerSelectionOrStart(), false);
    assert.equal(game.isChoosingPartners(), false);
    assert.deepEqual(game.players.map((p) => String(p.userId)), order);
  } finally {
    game.destroy();
  }
});

// ── telling the moved player where they now sit ──────────────────────────────
//
// Re-seating is invisible to a client that was told its seat once, at join
// time. The player who moved then indexes everything — their hand, and the
// rotation that draws them at the bottom of the felt with their partner
// opposite — by a chair that now belongs to someone else. Every snapshot has
// to say which seat it was masked for.

test("every Trix snapshot says which seat it was masked for", async () => {
  const game = new TrixGame("trix_view_seat", { gameMode: "partnership" });
  try {
    for (let i = 0; i < 4; i += 1) {
      game.players.push({
        userId: `u${i}`,
        seatIndex: i,
        isBot: false,
        displayName: `P${i}`,
        chips: 100,
      });
    }
    await game._dealOrChoosePartners();
    // u1 is the one who moves: seat 1 -> seat 2, opposite the chooser.
    game.choosePartner(1, "u0");
    game.respondToPartner(true, "u1");
    await new Promise((r) => setTimeout(r, 10));

    const movedTo = game.players.findIndex((p) => String(p.userId) === "u1");
    assert.equal(movedTo, 2, "the partner sits opposite the chooser");

    const state = game.getGameState(movedTo);
    assert.equal(state.viewPlayerIndex, movedTo);
    // The symptom of following the stale seat: a hand full of nulls.
    assert.ok(
      state.hands[movedTo].every((c) => c && c.rank),
      "the seat the snapshot is for holds real cards",
    );
    assert.ok(
      state.hands[1].every((c) => c === null),
      "the seat they joined on is now masked from them",
    );
    assert.equal(
      String(state.seatsPublic[movedTo].userId),
      "u1",
      "and the roster agrees with the stamp",
    );

    game.clearBotTimer();
    game.clearTurnTimer();
  } finally {
    game.destroy();
  }
});

test("every Tarneeb snapshot says which seat it was masked for", async () => {
  const game = new Tarneeb41Game("t41_view_seat", { mongoTableId: "t1" });
  try {
    for (let i = 0; i < 4; i += 1) {
      game.players.push({
        userId: `u${i}`,
        socketId: `s${i}`,
        seatIndex: i,
        isBot: false,
        displayName: `P${i}`,
        chips: 1000,
      });
    }
    game.startOrWaitForPlayers();
    game.choosePartner(3, "u0");
    game.respondToPartner(true, "u3");
    await new Promise((r) => setTimeout(r, 10));

    const movedTo = game.players.findIndex((p) => String(p.userId) === "u3");
    assert.equal(movedTo, 2, "the partner sits opposite the chooser");

    for (let seat = 0; seat < 4; seat += 1) {
      assert.equal(
        game.getGameState(seat).viewPlayerIndex,
        seat,
        `seat ${seat}'s snapshot is stamped for seat ${seat}`,
      );
    }
    assert.equal(
      String(game.getGameState(movedTo).seatsPublic[movedTo].userId),
      "u3",
    );
  } finally {
    game.destroy();
  }
});

// ── telling each client which half of the exchange is theirs ─────────────────
//
// The payload is one broadcast to the whole room, so it cannot be masked per
// viewer — each client has to recognise itself in it. A seat index is not
// enough: `reindexByChair` renumbers every seat when bots fill the empty
// chairs, and nothing tells the clients. The player who moved was shown the
// watcher face and never offered قبول/رفض, so the pairing timed out.

test("the payload identifies the players, not just their chairs", () => {
  const players = roster(FOUR_HUMANS);
  const sel = new PartnerSelection({
    roomId: "ids",
    getPlayers: () => players,
    onSeatsArranged: () => {},
    onSettled: () => {},
  });
  try {
    sel.begin();
    sel.choose(2, "a");

    const p = sel.toPayload();
    assert.equal(p.chooserUserId, "a");
    assert.equal(p.pendingPartnerUserId, "c", "the invited player by id");
    assert.deepEqual(
      p.seats.map((s) => s.userId),
      ["a", "b", "c", "d"],
      "and the roster, so a renumbered client can find itself again",
    );
  } finally {
    sel.destroy();
  }
});

test("a bot carries no userId that a human could match", () => {
  const players = roster([{ id: "a" }, { id: "bot1", bot: true }, { id: "c" }, { id: "d" }]);
  const sel = new PartnerSelection({
    roomId: "ids_bot",
    getPlayers: () => players,
    onSeatsArranged: () => {},
    onSettled: () => {},
  });
  try {
    sel.begin();
    const p = sel.toPayload();
    assert.equal(p.seats[1].userId, null);
    assert.equal(p.seats[1].isBot, true);
    assert.equal(p.seats[0].userId, "a");
  } finally {
    sel.destroy();
  }
});

test("a refusal is reported back to the chooser, then cleared", () => {
  const players = roster(FOUR_HUMANS);
  const sel = new PartnerSelection({
    roomId: "declines",
    getPlayers: () => players,
    onSeatsArranged: () => {},
    onSettled: () => {},
  });
  try {
    sel.begin();
    sel.choose(1, "a");
    assert.equal(sel.toPayload().lastDeclinedName, null, "nothing refused yet");

    sel.respond(false, "b");
    const after = sel.toPayload();
    assert.equal(after.phase, PHASE.CHOOSING, "the chooser picks again");
    assert.equal(after.lastDeclinedName, "b", "and is told who said no");
    assert.equal(after.lastDeclineReason, "declined");

    // Asking someone new is a fresh question, not a report on the old one.
    sel.choose(2, "a");
    const next = sel.toPayload();
    assert.equal(next.lastDeclinedName, null);
    assert.equal(next.lastDeclineReason, null);
  } finally {
    sel.destroy();
  }
});

test("a decline by silence is distinguishable from a real no", async () => {
  const players = roster(FOUR_HUMANS);
  const sel = new PartnerSelection({
    roomId: "silence",
    getPlayers: () => players,
    onSeatsArranged: () => {},
    onSettled: () => {},
  });
  try {
    sel.begin();
    sel.choose(1, "a");
    sel._declineCurrent("accept_timeout");

    const p = sel.toPayload();
    assert.equal(p.lastDeclinedName, "b");
    assert.equal(
      p.lastDeclineReason,
      "accept_timeout",
      "the chooser is told they went unanswered, not turned down",
    );
  } finally {
    sel.destroy();
  }
});
