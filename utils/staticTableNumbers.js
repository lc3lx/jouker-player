/**
 * Which `tableNumber` values belong to permanent (static) rooms.
 *
 * The original rule was simple: 1–4 were the four static rooms of a tier and
 * anything above was an overflow table the allocator had spawned. Several
 * places still lean on that, notably the lifecycle backfill and the
 * `allocator_mismarked_overflow_tables` health check.
 *
 * It stopped being true when a stake started offering more than one permanent
 * room — poker's humans-only five-max, and trix's شركة variant alongside
 * اليهودية. Those are seeded from 101 up, deliberately clear of the low
 * numbers (already spoken for) and of the overflow range (the allocator claims
 * `maxTableNumber + 1`, so a static upsert down there could land on top of a
 * live dynamic table).
 *
 * The cost of that choice was a false alarm: the health check read the twelve
 * five-max rooms as "overflow tables that will never be garbage-collected" and
 * raised a critical alert on every sweep. This module is the single definition
 * of the reserved band, so the seeder and the checks cannot drift apart again.
 */

/** Base tables of a tier: 1–4, one per stake. */
const BASE_STATIC_TABLE_NUMBERS = [1, 2, 3, 4];

/**
 * Variant rooms — a second permanent room at the same stake, differing by size
 * or by rule variant. Numbered `VARIANT_BASE + 1 ..+ 4`, one per stake.
 */
const VARIANT_TABLE_NUMBER_BASE = 100;
const VARIANT_TABLE_NUMBER_MIN = VARIANT_TABLE_NUMBER_BASE + 1;
const VARIANT_TABLE_NUMBER_MAX = VARIANT_TABLE_NUMBER_BASE + 99;

/** True for a number the seeder reserves for a permanent room. */
function isReservedStaticTableNumber(tableNumber) {
  const n = Number(tableNumber);
  if (!Number.isFinite(n)) return false;
  if (BASE_STATIC_TABLE_NUMBERS.includes(n)) return true;
  return n >= VARIANT_TABLE_NUMBER_MIN && n <= VARIANT_TABLE_NUMBER_MAX;
}

/**
 * Mongo predicate for "this number was allocated to an overflow table", i.e.
 * everything the seeder does not reserve. Use it wherever `tableNumber > 4`
 * used to stand in for that.
 */
const OVERFLOW_TABLE_NUMBER_QUERY = {
  $gt: BASE_STATIC_TABLE_NUMBERS.length,
  $not: { $gte: VARIANT_TABLE_NUMBER_MIN, $lte: VARIANT_TABLE_NUMBER_MAX },
};

module.exports = {
  BASE_STATIC_TABLE_NUMBERS,
  VARIANT_TABLE_NUMBER_BASE,
  VARIANT_TABLE_NUMBER_MIN,
  VARIANT_TABLE_NUMBER_MAX,
  isReservedStaticTableNumber,
  OVERFLOW_TABLE_NUMBER_QUERY,
};
