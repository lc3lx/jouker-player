const PlayerAnalytics = require("../models/playerAnalyticsModel");

function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 1000) / 10;
}

function isPreflop(action) {
  return !action.round || action.round === "preflop";
}

function isAggressive(action) {
  const t = String(action?.type || "");
  return ["bet", "raise", "allin", "all-in"].includes(t);
}

function isCall(action) {
  return String(action?.type || "") === "call";
}

function isFold(action) {
  return String(action?.type || "") === "fold";
}

function isCheck(action) {
  return String(action?.type || "") === "check";
}

function analyzeHandActions(actions = []) {
  const preflopRaises = actions.filter((a) => isPreflop(a) && isAggressive(a));
  const preflopCalls = actions.filter((a) => isPreflop(a) && isCall(a));
  const flopBets = actions.filter((a) => a.round === "flop" && isAggressive(a));
  const sawFlop = actions.some((a) => a.round === "flop" || a.type === "street");
  const sawShowdown = actions.some((a) => a.type === "showdown" || a.round === "showdown");
  return { preflopRaises, preflopCalls, flopBets, sawFlop, sawShowdown };
}

function perPlayerCounters(userActions, allActions) {
  const preflop = userActions.filter(isPreflop);
  const voluntary = preflop.filter((a) => isCall(a) || isAggressive(a));
  const pfr = preflop.filter(isAggressive);
  const preflopAgg = preflop.filter(isAggressive).length;
  const preflopCalls = preflop.filter(isCall).length;
  const betsRaises =
    userActions.filter(isAggressive).length;
  const calls = userActions.filter(isCall).length;
  const checks = userActions.filter(isCheck).length;

  const raisesBefore = allActions.filter(
    (a) => isPreflop(a) && isAggressive(a) && (a.ts || 0) < (userActions[0]?.ts || Infinity)
  ).length;
  const threeBet = preflopAgg >= 1 && raisesBefore >= 1 ? 1 : 0;
  const fourBet = preflopAgg >= 1 && raisesBefore >= 2 ? 1 : 0;

  const facedThreeBet = preflop.some(
    (a, i) =>
      isFold(a) &&
      preflop.slice(0, i).filter(isAggressive).length >= 2
  )
    ? 1
    : 0;
  const foldedToThreeBet = facedThreeBet && preflop.some(isFold) ? 1 : 0;

  const flopActions = userActions.filter((a) => a.round === "flop");
  const cbetOpportunity =
    allActions.some((a) => a.round === "preflop" && isAggressive(a)) &&
    flopActions.length > 0
      ? 1
      : 0;
  const cbet = cbetOpportunity && flopActions.some(isAggressive) ? 1 : 0;
  const facedCbet =
    allActions.some((a) => a.round === "flop" && isAggressive(a)) &&
    flopActions.some(isFold)
      ? 1
      : 0;
  const foldToCbet = facedCbet && flopActions.some(isFold) ? 1 : 0;

  const checkRaise =
    userActions.some(
      (a, i, arr) =>
        isCheck(a) &&
        arr.slice(i + 1).some((x) => isAggressive(x))
    )
      ? 1
      : 0;

  const stealAttempt = preflopAgg >= 1 ? 1 : 0;
  const foldBb = preflop.some((a) => a.position === "bb" && isFold(a)) ? 1 : 0;
  const foldSb = preflop.some((a) => a.position === "sb" && isFold(a)) ? 1 : 0;

  return {
    voluntary: voluntary.length ? 1 : 0,
    pfr: pfr.length ? 1 : 0,
    threeBet,
    fourBet,
    foldedToThreeBet,
    facedThreeBet,
    cbet,
    cbetOpportunity,
    foldToCbet,
    facedCbet,
    betsRaises,
    calls,
    checks,
    checkRaise,
    stealAttempt,
    foldBb,
    foldSb,
    sawFlop: analyzeHandActions(allActions).sawFlop ? 1 : 0,
    sawShowdown: analyzeHandActions(allActions).sawShowdown ? 1 : 0,
  };
}

async function bumpAnalytics(userId, gameType, inc, extra = {}) {
  const update = { $inc: inc };
  if (extra.$max) update.$max = extra.$max;
  if (extra.$set) update.$set = extra.$set;
  await PlayerAnalytics.findOneAndUpdate(
    { user: userId, gameType, period: "all" },
    update,
    { upsert: true }
  );
}

async function recordHandStats({
  handId,
  gameType = "poker",
  seats = [],
  winners = [],
  pot = 0,
  rake = 0,
  actions = [],
}) {
  const winnerIds = new Set(
    (winners || []).map((w) => String(w.user || w.userId || "")).filter(Boolean)
  );

  for (const seat of seats) {
    const uid = seat.user || seat.userId;
    if (!uid || seat.isBot) continue;

    const userActions = (actions || []).filter(
      (a) => String(a.playerId) === String(uid)
    );
    const c = perPlayerCounters(userActions, actions);
    const won = winnerIds.has(String(uid));
    const net =
      (seat.chipsAfter ?? seat.chips ?? 0) -
      (seat.chipsBefore ?? seat.handStartChips ?? 0);
    const wonShowdown = won && c.sawShowdown;

    const streakInc = won ? 1 : 0;
    const doc = await PlayerAnalytics.findOne({ user: uid, gameType, period: "all" });
    const currentStreak = doc?.currentWinStreak || 0;
    const newStreak = won ? currentStreak + 1 : 0;
    const longest = Math.max(doc?.longestWinStreak || 0, newStreak);
    const longestLose = won
      ? doc?.longestLoseStreak || 0
      : Math.max(doc?.longestLoseStreak || 0, (doc?.currentLoseStreak || 0) + 1);

    await bumpAnalytics(
      uid,
      gameType,
      {
        handsPlayed: 1,
        handsWon: won ? 1 : 0,
        totalProfit: net,
        totalInvested: Math.max(0, net < 0 ? -net : 0),
        totalPotSeen: pot,
        sessionsPlayed: 0,
        "rawCounters.voluntary": c.voluntary,
        "rawCounters.pfr": c.pfr,
        "rawCounters.threeBet": c.threeBet,
        "rawCounters.fourBet": c.fourBet,
        "rawCounters.foldedToThreeBet": c.foldedToThreeBet,
        "rawCounters.facedThreeBet": c.facedThreeBet,
        "rawCounters.cbet": c.cbet,
        "rawCounters.cbetOpportunity": c.cbetOpportunity,
        "rawCounters.foldToCbet": c.foldToCbet,
        "rawCounters.facedCbet": c.facedCbet,
        "rawCounters.betsRaises": c.betsRaises,
        "rawCounters.calls": c.calls,
        "rawCounters.checks": c.checks,
        "rawCounters.checkRaise": c.checkRaise,
        "rawCounters.stealAttempt": c.stealAttempt,
        "rawCounters.foldBb": c.foldBb,
        "rawCounters.foldSb": c.foldSb,
        "rawCounters.sawFlop": c.sawFlop,
        "rawCounters.sawShowdown": c.sawShowdown,
        "rawCounters.wonShowdown": wonShowdown ? 1 : 0,
      },
      {
        $max: { biggestPotWon: won ? pot : 0 },
        $set: {
          currentWinStreak: newStreak,
          currentLoseStreak: won ? 0 : (doc?.currentLoseStreak || 0) + 1,
          longestWinStreak: longest,
          longestLoseStreak: longestLose,
        },
      }
    );
  }
}

async function recordCardGameMatch({ gameType, gameResult, players = [], settlement }) {
  for (const p of players) {
    const uid = p.userId || p.user;
    if (!uid) continue;
    const won = gameResult?.winnerIndex === p.seatIndex || gameResult?.winnerTeam === p.team;
    await bumpAnalytics(uid, gameType, {
      handsPlayed: 1,
      handsWon: won ? 1 : 0,
      totalProfit: settlement?.totalPayout ? (won ? settlement.totalPayout / players.length : 0) : 0,
    });
  }
}

function computeDerived(doc) {
  const hands = doc.handsPlayed || 0;
  const rc = doc.rawCounters || {};
  const voluntary = rc.voluntary || 0;
  const pfr = rc.pfr || 0;
  const betsRaises = rc.betsRaises || 0;
  const calls = rc.calls || 0;
  const checks = rc.checks || 0;
  const sawShowdown = rc.sawShowdown || 0;
  const wonShowdown = rc.wonShowdown || 0;
  const avgPot = hands ? Math.round((doc.totalPotSeen || 0) / hands) : 0;

  return {
    handsPlayed: hands,
    handsWon: doc.handsWon || 0,
    vpip: pct(voluntary, hands),
    pfr: pct(pfr, hands),
    threeBet: pct(rc.threeBet || 0, rc.facedThreeBet || hands),
    fourBet: pct(rc.fourBet || 0, hands),
    foldToThreeBet: pct(rc.foldedToThreeBet || 0, rc.facedThreeBet || 0),
    foldToCBet: pct(rc.foldToCbet || 0, rc.facedCbet || 0),
    wtsd: pct(sawShowdown, rc.sawFlop || hands),
    wsd: pct(wonShowdown, sawShowdown),
    aggressionFactor: calls ? Math.round((betsRaises / calls) * 100) / 100 : betsRaises,
    aggressionFrequency: pct(betsRaises, betsRaises + calls + checks),
    stealPct: pct(rc.stealAttempt || 0, hands),
    foldBb: pct(rc.foldBb || 0, hands),
    foldSb: pct(rc.foldSb || 0, hands),
    checkRaise: pct(rc.checkRaise || 0, hands),
    continuationBet: pct(rc.cbet || 0, rc.cbetOpportunity || 0),
    avgPot,
    avgSession: doc.avgSession || 0,
    avgBuyIn: doc.avgBuyIn || 0,
    handsPerHour: doc.handsPerHour || 0,
    roi: doc.totalInvested
      ? pct(doc.totalProfit || 0, doc.totalInvested)
      : 0,
    netProfit: doc.totalProfit || 0,
    largestPot: doc.biggestPotWon || 0,
    winningStreak: doc.longestWinStreak || 0,
    losingStreak: doc.longestLoseStreak || 0,
    winRate: pct(doc.handsWon || 0, hands),
  };
}

async function getUserAnalytics(userId, gameType = "poker") {
  const doc = await PlayerAnalytics.findOne({ user: userId, gameType, period: "all" }).lean();
  if (!doc) {
    return computeDerived({ handsPlayed: 0, rawCounters: {} });
  }
  return computeDerived(doc);
}

async function exportUserAnalytics(userId, gameType = "poker") {
  const data = await getUserAnalytics(userId, gameType);
  const monthly = await PlayerAnalytics.find({ user: userId, gameType, period: "monthly" }).lean();
  return { userId: String(userId), gameType, allTime: data, monthly };
}

module.exports = {
  recordHandStats,
  recordCardGameMatch,
  getUserAnalytics,
  exportUserAnalytics,
  computeDerived,
};
