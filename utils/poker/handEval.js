const RANK_ORDER = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

function parseCard(card) {
  // e.g. "Ah", "Td", "7s"
  const r = card[0];
  const s = card[1];
  return { r, s, v: RANK_ORDER[r] };
}

function countsByRank(cards) {
  const map = new Map();
  for (const c of cards) {
    map.set(c.v, (map.get(c.v) || 0) + 1);
  }
  return map;
}

function isFlush(cards) {
  const suit = cards[0].s;
  return cards.every((c) => c.s === suit);
}

function isStraight(values) {
  // values must be sorted descending unique
  if (values.length < 5) return { ok: false };
  // Handle wheel straight A-2-3-4-5
  const set = new Set(values);
  const wheel = [5, 4, 3, 2, 14];
  if (wheel.every((v) => set.has(v))) return { ok: true, high: 5 };

  for (let i = 0; i <= values.length - 5; i++) {
    const slice = values.slice(i, i + 5);
    if (
      slice[0] - 1 === slice[1] &&
      slice[1] - 1 === slice[2] &&
      slice[2] - 1 === slice[3] &&
      slice[3] - 1 === slice[4]
    ) {
      return { ok: true, high: slice[0] };
    }
  }
  return { ok: false };
}

function rank5(cards5) {
  const cards = cards5.map(parseCard).sort((a, b) => b.v - a.v);
  const counts = countsByRank(cards);
  const entries = Array.from(counts.entries()).sort((a, b) => {
    // sort by count desc, then rank desc
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });
  const uniqueValues = Array.from(new Set(cards.map((c) => c.v))).sort((a, b) => b - a);

  const flush = isFlush(cards);
  const straight = isStraight(uniqueValues);

  // Straight flush
  if (flush && straight.ok) {
    return { cat: 8, tiebreak: [straight.high] };
  }

  // Four of a kind
  if (entries[0][1] === 4) {
    const four = entries[0][0];
    const kicker = entries.find((e) => e[0] !== four)[0];
    return { cat: 7, tiebreak: [four, kicker] };
  }

  // Full house
  if (entries[0][1] === 3 && entries[1][1] === 2) {
    return { cat: 6, tiebreak: [entries[0][0], entries[1][0]] };
  }

  // Flush
  if (flush) {
    return { cat: 5, tiebreak: cards.map((c) => c.v) };
  }

  // Straight
  if (straight.ok) {
    return { cat: 4, tiebreak: [straight.high] };
  }

  // Three of a kind
  if (entries[0][1] === 3) {
    const trips = entries[0][0];
    const kickers = entries.filter((e) => e[0] !== trips).map((e) => e[0]).sort((a, b) => b - a);
    return { cat: 3, tiebreak: [trips, ...kickers.slice(0, 2)] };
  }

  // Two pair
  if (entries[0][1] === 2 && entries[1][1] === 2) {
    const highPair = Math.max(entries[0][0], entries[1][0]);
    const lowPair = Math.min(entries[0][0], entries[1][0]);
    const kicker = entries.find((e) => e[1] === 1)[0];
    return { cat: 2, tiebreak: [highPair, lowPair, kicker] };
  }

  // One pair
  if (entries[0][1] === 2) {
    const pair = entries[0][0];
    const kickers = entries.filter((e) => e[0] !== pair).map((e) => e[0]).sort((a, b) => b - a);
    return { cat: 1, tiebreak: [pair, ...kickers.slice(0, 3)] };
  }

  // High card
  return { cat: 0, tiebreak: cards.map((c) => c.v) };
}

function combinations(arr, k) {
  const res = [];
  const n = arr.length;
  const idx = Array.from({ length: k }, (_, i) => i);
  function pushComb() {
    res.push(idx.map((i) => arr[i]));
  }
  pushComb();
  while (true) {
    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    pushComb();
  }
  return res;
}

function bestOf7(cards7) {
  // cards7: array of 7 card strings
  const combs = combinations(cards7, 5);
  let best = null;
  for (const c of combs) {
    const r = rank5(c);
    if (
      !best ||
      r.cat > best.cat ||
      (r.cat === best.cat && compareTiebreak(r.tiebreak, best.tiebreak) > 0)
    ) {
      best = r;
    }
  }
  return best;
}

function compareTiebreak(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function compareHands7(a7, b7) {
  const A = bestOf7(a7);
  const B = bestOf7(b7);
  if (A.cat !== B.cat) return A.cat - B.cat;
  return compareTiebreak(A.tiebreak, B.tiebreak);
}

module.exports = { bestOf7, compareHands7 };
