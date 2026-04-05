/**
 * Rolling session analytics (RTP slice, spin counts, big-win frequency).
 */

const SESSION_GAP_MS = 30 * 60 * 1000;

/** @type {import('redis').RedisClientType | null} */
let redis = null;

function setRedisClient(client) {
  redis = client && typeof client.hGetAll === "function" ? client : null;
}

function keySession(userId) {
  return `ka:an:sess:${String(userId)}`;
}
function keyLast(userId) {
  return `ka:an:last:${String(userId)}`;
}

const mem = new Map();

async function touchSession(userId) {
  const now = Date.now();
  if (!redis) {
    const k = String(userId);
    const last = mem.get(`${k}:last`) || 0;
    if (now - last > SESSION_GAP_MS) {
      mem.set(`${k}:sess`, {
        startedAt: now,
        bet: 0,
        payout: 0,
        spins: 0,
        bigWins: 0,
        megaWins: 0,
      });
    }
    mem.set(`${k}:last`, now);
    return mem.get(`${k}:sess`) || { startedAt: now, bet: 0, payout: 0, spins: 0, bigWins: 0, megaWins: 0 };
  }

  const lastRaw = await redis.get(keyLast(userId));
  const last = lastRaw ? parseInt(lastRaw, 10) : 0;
  if (now - last > SESSION_GAP_MS) {
    await redis.del(keySession(userId));
    await redis.hSet(keySession(userId), {
      startedAt: String(now),
      bet: "0",
      payout: "0",
      spins: "0",
      bigWins: "0",
      megaWins: "0",
    });
  }
  await redis.set(keyLast(userId), String(now), { EX: 48 * 3600 });

  const h = await redis.hGetAll(keySession(userId));
  if (!h || Object.keys(h).length === 0) {
    await redis.hSet(keySession(userId), {
      startedAt: String(now),
      bet: "0",
      payout: "0",
      spins: "0",
      bigWins: "0",
      megaWins: "0",
    });
  }
  return redis.hGetAll(keySession(userId));
}

async function recordSpinAnalytics(userId, stake, payout, winType) {
  await touchSession(userId);

  if (!redis) {
    const k = String(userId);
    let s = mem.get(`${k}:sess`);
    if (!s) {
      s = { startedAt: Date.now(), bet: 0, payout: 0, spins: 0, bigWins: 0, megaWins: 0 };
    }
    s.bet += stake;
    s.payout += payout;
    s.spins += 1;
    if (winType === "big") s.bigWins += 1;
    if (winType === "mega") s.megaWins += 1;
    mem.set(`${k}:sess`, s);
    return;
  }

  const ks = keySession(userId);
  await redis.hIncrBy(ks, "bet", Math.round(stake * 100));
  await redis.hIncrBy(ks, "payout", Math.round(payout * 100));
  await redis.hIncrBy(ks, "spins", 1);
  if (winType === "big") await redis.hIncrBy(ks, "bigWins", 1);
  if (winType === "mega") await redis.hIncrBy(ks, "megaWins", 1);
}

/**
 * @returns {Promise<{ sessionRTP: number, spins: number, avgStake: number, bigWinRate: number, megaWinRate: number }>}
 */
async function getSessionSummary(userId) {
  await touchSession(userId);

  if (!redis) {
    const k = String(userId);
    const s = mem.get(`${k}:sess`) || { bet: 0, payout: 0, spins: 0, bigWins: 0, megaWins: 0 };
    const spins = s.spins || 0;
    const bet = s.bet || 0;
    const payout = s.payout || 0;
    return {
      sessionRTP: bet > 0 ? payout / bet : 0,
      spins,
      avgStake: spins > 0 ? bet / spins : 0,
      bigWinRate: spins > 0 ? s.bigWins / spins : 0,
      megaWinRate: spins > 0 ? s.megaWins / spins : 0,
    };
  }

  const h = await redis.hGetAll(keySession(userId));
  const spins = parseInt(h.spins || "0", 10);
  const betCents = parseInt(h.bet || "0", 10);
  const payCents = parseInt(h.payout || "0", 10);
  const bet = betCents / 100;
  const payout = payCents / 100;
  const bigWins = parseInt(h.bigWins || "0", 10);
  const megaWins = parseInt(h.megaWins || "0", 10);
  return {
    sessionRTP: bet > 0 ? payout / bet : 0,
    spins,
    avgStake: spins > 0 ? bet / spins : 0,
    bigWinRate: spins > 0 ? bigWins / spins : 0,
    megaWinRate: spins > 0 ? megaWins / spins : 0,
  };
}

module.exports = {
  setRedisClient,
  recordSpinAnalytics,
  getSessionSummary,
};
