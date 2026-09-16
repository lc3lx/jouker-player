#!/usr/bin/env node
/**
 * Release seats left behind by players who never came back.
 *
 * Before the boot sanitiser learned to watch preserved seats, a seat survived
 * every restart: the owner stayed pinned by the one-table-per-player gate (every
 * later join answered "you are already active at another table", or bounced them
 * into a waiting queue) and their buy-in stayed locked indefinitely.
 *
 * The server now expires unclaimed seats on its own. This script clears the ones
 * already stuck, refunding each seat's chips from lockedBalance back to balance
 * through the normal ledger paths.
 *
 *   node scripts/releaseOrphanSeats.js                 # dry run — prints only
 *   node scripts/releaseOrphanSeats.js --apply         # perform the release
 *   node scripts/releaseOrphanSeats.js --apply --older-than-hours=1
 *
 * Default cutoff is 6 hours, so a table in use right now is never touched.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const hoursArg = args.find((a) => a.startsWith("--older-than-hours="));
const OLDER_THAN_HOURS = hoursArg ? Number(hoursArg.split("=")[1]) : 6;

function uri() {
  const u = process.env.DB_URI || process.env.MONGO_URI || process.env.DATABASE;
  if (!u) throw new Error("No DB_URI / MONGO_URI in the environment");
  return u;
}

async function main() {
  if (!Number.isFinite(OLDER_THAN_HOURS) || OLDER_THAN_HOURS < 0) {
    throw new Error(`--older-than-hours must be a number, got ${OLDER_THAN_HOURS}`);
  }
  await mongoose.connect(uri());

  const Table = require("../models/tableModel");
  const {
    withMongoTransaction,
    releaseTableSeatToBalance,
  } = require("../services/walletLedgerService");

  const cutoff = Date.now() - OLDER_THAN_HOURS * 3600 * 1000;
  const tables = await Table.find({ "seats.0": { $exists: true } });

  const stale = [];
  for (const t of tables) {
    const seats = (t.seats || []).filter((s) => {
      const joined = s.joinedAt ? new Date(s.joinedAt).getTime() : 0;
      return s.user && joined > 0 && joined < cutoff;
    });
    if (seats.length > 0) stale.push({ table: t, seats });
  }

  if (stale.length === 0) {
    console.log(`No seats older than ${OLDER_THAN_HOURS}h. Nothing to do.`);
    await mongoose.disconnect();
    return;
  }

  console.log(
    `${APPLY ? "RELEASING" : "DRY RUN — would release"} seats idle for more than ${OLDER_THAN_HOURS}h:\n`
  );
  let seatTotal = 0;
  let chipTotal = 0;
  for (const { table, seats } of stale) {
    console.log(
      `  ${table.gameType} ${table.tier} #${table.tableNumber} (${table.status})  ${table._id}`
    );
    for (const s of seats) {
      seatTotal += 1;
      chipTotal += Number(s.chips) || 0;
      console.log(
        `      user ${s.user}  chips ${s.chips}  seated since ${new Date(s.joinedAt).toISOString()}`
      );
    }
  }
  console.log(`\n  ${seatTotal} seat(s), ${chipTotal} chips across ${stale.length} table(s).`);

  if (!APPLY) {
    console.log("\nRe-run with --apply to release them.");
    await mongoose.disconnect();
    return;
  }

  let released = 0;
  let refunded = 0;
  for (const { table, seats } of stale) {
    for (const s of seats) {
      const chips = Math.max(0, Number(s.chips) || 0);
      try {
        await withMongoTransaction(async (session) => {
          if (chips > 0) {
            await releaseTableSeatToBalance({
              session,
              userId: s.user,
              tableId: table._id,
              seatChips: chips,
              meta: {
                reason: "orphan_seat_release_script",
                tableNumber: table.tableNumber,
                gameType: table.gameType,
              },
            });
          }
          await Table.updateOne(
            { _id: table._id },
            {
              $pull: {
                seats: { user: s.user },
                vacatingPlayers: { user: s.user },
                waitingQueue: { user: s.user },
              },
            },
            { session }
          );
        });
        released += 1;
        refunded += chips;
        console.log(`  released ${s.user} from ${table._id} (+${chips} chips)`);
      } catch (e) {
        // A seat whose lock was already settled has nothing to refund; free the
        // seat anyway so the player stops being pinned to this table.
        console.warn(`  refund failed for ${s.user} on ${table._id}: ${e.message}`);
        await Table.updateOne(
          { _id: table._id },
          {
            $pull: {
              seats: { user: s.user },
              vacatingPlayers: { user: s.user },
              waitingQueue: { user: s.user },
            },
          }
        );
        released += 1;
        console.log(`  seat freed without refund: ${s.user} on ${table._id}`);
      }
    }
    const fresh = await Table.findById(table._id).select("seats gameType");
    if (fresh && fresh.seats.length === 0) {
      await Table.updateOne(
        { _id: table._id },
        {
          $set: {
            status: fresh.gameType === "poker" ? "waiting" : "open",
            activeSettlementId: null,
          },
        }
      );
    }
  }

  console.log(`\nDone. Released ${released} seat(s), refunded ${refunded} chips.`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
