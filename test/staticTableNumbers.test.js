/**
 * `tableNumber > 4` no longer means "overflow table".
 *
 * Observed in production: the monitor raised
 *
 *   monitor_allocator_mismarked_overflow_tables  severity:"critical"
 *   "12 overflow table(s) (tableNumber>4) are not tableKind:dynamic/vip/
 *    tournament — will never be garbage-collected"   consecutiveSweeps:18
 *
 * on every sweep, forever. The twelve were the humans-only five-max poker
 * rooms, which are deliberately permanent and deliberately numbered 101–104
 * per tier. Trix's شركة rooms land in the same band, so the alert would have
 * doubled to 24.
 *
 * The reserved band now lives in one module that both the seeder and the check
 * read, and these pin its shape — including against a real MongoDB, because the
 * predicate is a `$not` range and a query that silently matches nothing would
 * hide the very drift this check exists to catch.
 */
process.env.NODE_ENV = "test";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const {
  BASE_STATIC_TABLE_NUMBERS,
  VARIANT_TABLE_NUMBER_BASE,
  VARIANT_TABLE_NUMBER_MIN,
  VARIANT_TABLE_NUMBER_MAX,
  isReservedStaticTableNumber,
  OVERFLOW_TABLE_NUMBER_QUERY,
} = require("../utils/staticTableNumbers");

test("the four base rooms of a tier are reserved", () => {
  for (const n of BASE_STATIC_TABLE_NUMBERS) {
    assert.equal(isReservedStaticTableNumber(n), true, `table ${n}`);
  }
  assert.deepEqual(BASE_STATIC_TABLE_NUMBERS, [1, 2, 3, 4]);
});

test("the variant rooms a stake's second room uses are reserved", () => {
  // Five-max poker and partnership trix both seed BASE + 1..4.
  for (let i = 1; i <= 4; i += 1) {
    assert.equal(
      isReservedStaticTableNumber(VARIANT_TABLE_NUMBER_BASE + i),
      true,
      `variant room ${VARIANT_TABLE_NUMBER_BASE + i}`,
    );
  }
});

test("overflow numbers are not reserved", () => {
  for (const n of [5, 6, 50, 99, 100, 200, 100000, 100001]) {
    assert.equal(isReservedStaticTableNumber(n), false, `table ${n}`);
  }
});

test("garbage in is not reserved", () => {
  for (const n of [null, undefined, NaN, "abc", {}, -1]) {
    assert.equal(isReservedStaticTableNumber(n), false);
  }
});

test("the band has room to grow but stops short of tournament numbering", () => {
  assert.equal(VARIANT_TABLE_NUMBER_MIN, 101);
  assert.ok(
    VARIANT_TABLE_NUMBER_MAX < 100000,
    "tournament tables number from 100001 — the bands must not meet",
  );
});

// ── the Mongo predicate ──────────────────────────────────────────────────────

const MONGO_URI = `mongodb://127.0.0.1:27017/static_table_numbers_${process.pid}`;
let mongoAvailable = false;
let Probe;

before(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
    mongoAvailable = true;
  } catch (_) {
    return;
  }
  Probe = mongoose.model(
    "StaticNumberProbe",
    new mongoose.Schema({ tableNumber: Number }),
  );
});

after(async () => {
  if (!mongoAvailable) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("the overflow query agrees with the helper, on a real server", async (t) => {
  if (!mongoAvailable) {
    t.skip("no local MongoDB");
    return;
  }

  const numbers = [1, 2, 3, 4, 5, 6, 50, 99, 100, 101, 102, 103, 104, 199, 200, 100001];
  await Probe.insertMany(numbers.map((tableNumber) => ({ tableNumber })));

  const matched = (
    await Probe.find({ tableNumber: OVERFLOW_TABLE_NUMBER_QUERY })
      .select("tableNumber")
      .lean()
  )
    .map((r) => r.tableNumber)
    .sort((a, b) => a - b);

  const expected = numbers
    .filter((n) => !isReservedStaticTableNumber(n))
    .sort((a, b) => a - b);

  assert.deepEqual(matched, expected);
  assert.ok(matched.length > 0, "a predicate that matches nothing hides real drift");
  assert.ok(
    !matched.includes(101) && !matched.includes(104),
    "the five-max and شركة rooms are never read as overflow",
  );
});
