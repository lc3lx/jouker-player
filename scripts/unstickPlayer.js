/**
 * unstickPlayer.js — release a player who is "stuck" active at one or more
 * tables (the one-table-per-player lock that causes 409 "You are already
 * active at another table" and blocks both joining and leaving).
 *
 * RUN THIS ON THE SERVER THAT OWNS THE DATABASE (e.g. the VPS), so it connects
 * to the real production DB via that machine's .env DB_URI — not a local dev DB.
 *
 * It DEFAULTS TO DRY-RUN (reads only, mutates nothing). Pass --apply to release.
 * The release path mirrors the in-app "leave table" flow exactly: it removes the
 * seat/vacate/queue entry inside a transaction and returns the seat chips to the
 * wallet via releaseTableSeatToBalance (the same tested primitive the game uses,
 * which caps the credit at the user's actually-locked balance so no phantom
 * money can ever be created). Mid-hand ("playing") tables are SKIPPED — leave
 * those from inside the app so the hand settles correctly.
 *
 * Usage:
 *   node scripts/unstickPlayer.js --email=you@example.com          # dry-run
 *   node scripts/unstickPlayer.js --userId=<24-hex-id>             # dry-run
 *   node scripts/unstickPlayer.js --email=you@example.com --apply  # release
 */
require("dotenv").config();
const mongoose = require("mongoose");
const dbConnection = require("../config/database");
const Table = require("../models/tableModel");
const User = require("../models/userModel");
const {
  withMongoTransaction,
  releaseTableSeatToBalance,
} = require("../services/walletLedgerService");

function arg(name) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=").slice(1).join("=") : null;
}
const APPLY = process.argv.includes("--apply");
// --force also releases seats on "playing" (mid-hand) tables. Use only for a
// stuck ORPHAN (a Mongo seat where the player isn't actually in the live hand,
// e.g. a failed bot-seat claim) — not while genuinely seated mid-hand.
const FORCE = process.argv.includes("--force");

(async () => {
  await dbConnection();
  console.log(`DB: ${mongoose.connection.name} @ ${mongoose.connection.host}`);
  console.log(APPLY ? "MODE: APPLY (will mutate the database)" : "MODE: DRY-RUN (read-only)");

  const email = arg("email");
  const userIdArg = arg("userId");
  let user;
  if (userIdArg) {
    user = await User.findById(userIdArg).select("_id email username walletBalance lockedBalance");
  } else if (email) {
    user = await User.findOne({ email }).select("_id email username walletBalance lockedBalance");
  }
  if (!user) {
    console.log("No user found. Pass --email=<login-email> or --userId=<id>.");
    await mongoose.disconnect();
    process.exit(1);
  }
  const uid = String(user._id);
  console.log(`USER: ${uid}  email=${user.email}  username=${user.username || "-"}`);
  console.log(`WALLET (before): balance=${user.walletBalance ?? "?"}  locked=${user.lockedBalance ?? "?"}`);

  const tables = await Table.find({
    $or: [
      { "seats.user": uid },
      { "vacatingPlayers.user": uid },
      { "waitingQueue.user": uid },
    ],
  }).select("gameType tier tableNumber status capacity seats vacatingPlayers waitingQueue");

  if (tables.length === 0) {
    console.log("\nNot active at any table — nothing to unstick.");
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`\nActive at ${tables.length} table(s):`);
  for (const t of tables) {
    const seat = (t.seats || []).find((s) => String(s.user) === uid);
    const vac = (t.vacatingPlayers || []).find((v) => String(v.user) === uid);
    const q = (t.waitingQueue || []).find((w) => String(w.user) === uid);
    const parts = [];
    if (seat) parts.push(`seat(${seat.chips || 0} chips)`);
    if (vac) parts.push(`vacating(${vac.chips || 0})`);
    if (q) parts.push(`queued(buyIn=${q.buyIn || 0})`);
    console.log(`  - ${t.gameType}/${t.tier} #${t.tableNumber} [${t.status}] id=${t._id}  ${parts.join(" ")}`);
  }

  if (!APPLY) {
    console.log("\nDRY-RUN only — nothing changed. Re-run with --apply to release these safely.");
    await mongoose.disconnect();
    process.exit(0);
  }

  for (const t of tables) {
    const id = String(t._id);
    if (t.status === "playing" && !FORCE) {
      console.log(`SKIP (mid-hand): ${t.gameType} #${t.tableNumber} id=${id} — leave from inside the app so the hand settles, or re-run with --force if this is a stuck orphan (not a live hand).`);
      continue;
    }
    if (t.status === "playing" && FORCE) {
      console.log(`FORCE releasing mid-hand table ${t.gameType} #${t.tableNumber} id=${id} — only safe for a stuck orphan.`);
    }
    try {
      await withMongoTransaction(async (session) => {
        const tx = await Table.findById(id).session(session);
        if (!tx) return;
        // Sum locked chips across seat / vacate / queue for this table. The
        // release is capped at the user's real global locked balance downstream,
        // so summing (even if seat+vacate briefly overlap) never over-credits.
        let chips = 0;
        const sIdx = tx.seats.findIndex((s) => String(s.user) === uid);
        if (sIdx !== -1) { chips += tx.seats[sIdx].chips || 0; tx.seats.splice(sIdx, 1); }
        const vIdx = (tx.vacatingPlayers || []).findIndex((v) => String(v.user) === uid);
        if (vIdx !== -1) { chips += tx.vacatingPlayers[vIdx].chips || 0; tx.vacatingPlayers.splice(vIdx, 1); }
        const qIdx = (tx.waitingQueue || []).findIndex((w) => String(w.user) === uid);
        if (qIdx !== -1) { chips += tx.waitingQueue[qIdx].buyIn || 0; tx.waitingQueue.splice(qIdx, 1); }
        if (tx.gameType === "tarneeb41" && tx.seats.length < tx.capacity) tx.status = "open";
        await tx.save({ session });
        if (chips > 0) {
          await releaseTableSeatToBalance({
            session,
            userId: user._id,
            seatChips: chips,
            tableId: tx._id,
            meta: { reason: "admin_unstick", tableNumber: tx.tableNumber },
          });
        }
        console.log(`RELEASED: ${tx.gameType} #${tx.tableNumber} id=${id} — returned up to ${chips} chips to wallet`);
      });
    } catch (e) {
      console.error(`FAILED on id=${id}: ${e.message}`);
    }
  }

  const after = await User.findById(uid).select("walletBalance lockedBalance");
  console.log(`\nWALLET (after): balance=${after?.walletBalance ?? "?"}  locked=${after?.lockedBalance ?? "?"}`);
  console.log("Done. Note: if the server uses a Redis-backed poker queue, a queued entry there is not in Mongo and won't show here.");
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
