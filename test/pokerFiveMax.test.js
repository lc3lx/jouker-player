/**
 * Five-handed poker tables.
 *
 * Every stake now runs two rooms: the original nine-max (bots fill it) and a
 * five-max that is humans only. The risks these cover:
 *  1. seeding must add the five-max rows without touching the nine-max ones;
 *  2. allocation must never mix the two — matching on stake alone would drop a
 *     five-max player into the nine-max room at the same buy-in;
 *  3. an overflow spilled from a five-max table must come back five-handed and
 *     still humans-only.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const Table = require("../models/tableModel");

function thenable(resolver) {
  const chain = {
    populate: () => chain,
    session: () => chain,
    select: () => chain,
    sort: () => chain,
    lean: async () => resolver(),
    then: (resolve, reject) => Promise.resolve(resolver()).then(resolve, reject),
  };
  return chain;
}

function freshAllocationService() {
  delete require.cache[require.resolve("../services/pokerTableAllocationService")];
  delete require.cache[require.resolve("../services/tableFactory")];
  return require("../services/pokerTableAllocationService");
}

// ─── seeding ────────────────────────────────────────────────────────────────

test("every stake is seeded with a nine-max and a humans-only five-max", async () => {
  const { FIXED_TIER_TABLES } = require("../services/tableService");
  const orig = { bulkWrite: Table.bulkWrite, updateMany: Table.updateMany, find: Table.find };

  let ops = [];
  Table.bulkWrite = async (list) => {
    ops = list;
    return { ok: 1 };
  };
  Table.updateMany = async () => ({ acknowledged: true });
  Table.find = () => thenable(() => []);

  try {
    delete require.cache[require.resolve("../services/tableService")];
    const svc = require("../services/tableService");
    await svc.ensureFixedTierTables();

    const poker = ops
      .map((o) => o.updateOne)
      .filter((u) => u?.filter?.gameType === "poker");

    const stakeCount = Object.values(FIXED_TIER_TABLES).flat().length;
    const nineMax = poker.filter((u) => u.update.$set.capacity === 9);
    const fiveMax = poker.filter((u) => u.update.$set.capacity === 5);

    assert.equal(nineMax.length, stakeCount, "one nine-max per stake");
    assert.equal(fiveMax.length, stakeCount, "one five-max per stake");

    for (const u of fiveMax) {
      assert.equal(
        u.update.$set["settings.botsEnabled"],
        false,
        "a five-max table must never fill with bots",
      );
      assert.equal(u.update.$set.tableKind, "static");
      assert.ok(
        u.filter.tableNumber > 100,
        "five-max numbering must stay clear of the dynamic/overflow range",
      );
    }

    for (const u of nineMax) {
      assert.ok(
        u.filter.tableNumber >= 1 && u.filter.tableNumber <= 4,
        "existing nine-max rows keep their numbers — the upsert must not move them",
      );
      assert.equal(
        u.update.$set["settings.botsEnabled"],
        undefined,
        "nine-max bot policy is left untouched",
      );
    }

    // Both rooms at one stake share blinds and buy-in — only the size differs.
    for (const five of fiveMax) {
      const nine = nineMax.find(
        (n) =>
          n.filter.tier === five.filter.tier &&
          n.update.$set.minBuyIn === five.update.$set.minBuyIn,
      );
      assert.ok(nine, "each five-max must pair with a nine-max at the same stake");
      assert.equal(five.update.$set.smallBlind, nine.update.$set.smallBlind);
      assert.equal(five.update.$set.bigBlind, nine.update.$set.bigBlind);
      assert.equal(five.update.$set.buyIn, nine.update.$set.buyIn);
    }
  } finally {
    Table.bulkWrite = orig.bulkWrite;
    Table.updateMany = orig.updateMany;
    Table.find = orig.find;
    delete require.cache[require.resolve("../services/tableService")];
  }
});

// ─── allocation keeps the sizes apart ───────────────────────────────────────

test("allocation asks for the requested table size, never the other one", async () => {
  const orig = { findOne: Table.findOne, create: Table.create };
  const queries = [];
  Table.findOne = (q) => {
    queries.push(q);
    return thenable(() => null);
  };
  Table.create = async (docs) => {
    const arr = Array.isArray(docs) ? docs : [docs];
    return arr.map((d, i) => ({ ...d, _id: `created-${i}` }));
  };

  try {
    const { findAvailablePokerTable } = freshAllocationService();
    await findAvailablePokerTable("beginner", 10000, null, { capacity: 5 });

    const lookup = queries.find((q) => q.gameType === "poker" && q.capacity != null);
    assert.ok(lookup, "the search must be constrained by capacity");
    assert.equal(lookup.capacity, 5, "a five-max request must not match a nine-max room");
  } finally {
    Table.findOne = orig.findOne;
    Table.create = orig.create;
    freshAllocationService();
  }
});

test("a five-max overflow is created five-handed and humans-only", async () => {
  const orig = { findOne: Table.findOne, create: Table.create };
  const created = [];
  Table.findOne = () => thenable(() => null);
  Table.create = async (docs) => {
    const arr = Array.isArray(docs) ? docs : [docs];
    created.push(arr[0]);
    return arr.map((d, i) => ({ ...d, _id: `created-${i}` }));
  };

  try {
    const { findAvailablePokerTable } = freshAllocationService();
    await findAvailablePokerTable("beginner", 10000, null, {
      capacity: 5,
      botsEnabled: false,
    });

    assert.equal(created.length, 1);
    assert.equal(created[0].capacity, 5, "overflow keeps the room size");
    assert.equal(
      created[0].settings?.botsEnabled,
      false,
      "overflow keeps the humans-only policy",
    );
    assert.equal(created[0].tableKind, "dynamic");
  } finally {
    Table.findOne = orig.findOne;
    Table.create = orig.create;
    freshAllocationService();
  }
});

test("a nine-max overflow is unchanged — still nine seats, bots allowed", async () => {
  const orig = { findOne: Table.findOne, create: Table.create };
  const created = [];
  Table.findOne = () => thenable(() => null);
  Table.create = async (docs) => {
    const arr = Array.isArray(docs) ? docs : [docs];
    created.push(arr[0]);
    return arr.map((d, i) => ({ ...d, _id: `created-${i}` }));
  };

  try {
    const { findAvailablePokerTable } = freshAllocationService();
    await findAvailablePokerTable("beginner", 10000, null);

    assert.equal(created.length, 1);
    assert.equal(created[0].capacity, 9);
    assert.equal(
      created[0].settings,
      undefined,
      "no settings override — the model default leaves bots enabled",
    );
  } finally {
    Table.findOne = orig.findOne;
    Table.create = orig.create;
    freshAllocationService();
  }
});
