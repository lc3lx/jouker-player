/**
 * grantAllPlayersChips.js — credit every real player wallet with a fixed amount.
 *
 * Uses ledgerDeposit (same ledger path as normal deposits) so balances stay
 * auditable. Defaults to DRY-RUN. Pass --apply to write.
 *
 * Bots are excluded by default (`isBot: true`). Pass --include-bots to credit them too.
 *
 * Usage (run on the machine that owns the DB / .env DB_URI):
 *   node scripts/grantAllPlayersChips.js                     # dry-run, 10_000_000
 *   node scripts/grantAllPlayersChips.js --apply             # credit 10M
 *   node scripts/grantAllPlayersChips.js --amount=5000000 --apply
 *   node scripts/grantAllPlayersChips.js --include-bots --apply
 */
require("dotenv").config();
const dbConnection = require("../config/database");
const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const {
  withMongoTransaction,
  ledgerDeposit,
} = require("../services/walletLedgerService");

function arg(name) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=").slice(1).join("=") : null;
}

const APPLY = process.argv.includes("--apply");
const INCLUDE_BOTS = process.argv.includes("--include-bots");
const AMOUNT = Math.max(0, Math.floor(Number(arg("amount") || 10_000_000)));

function fmt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

async function main() {
  if (!AMOUNT) {
    console.error("Amount must be > 0");
    process.exit(1);
  }

  await dbConnection();

  const filter = INCLUDE_BOTS ? {} : { isBot: { $ne: true } };
  const users = await User.find(filter).select("_id name email isBot").lean();
  console.log(`Players matched: ${users.length} (includeBots=${INCLUDE_BOTS})`);
  console.log(`Grant amount: ${fmt(AMOUNT)}`);
  console.log(`Mode: ${APPLY ? "APPLY (will write)" : "DRY-RUN (no writes)"}`);

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (const user of users) {
    const uid = String(user._id);
    const beforeWallet = await Wallet.findOne({ user: user._id }).lean();
    const beforeBal = beforeWallet ? Number(beforeWallet.balance || 0) : 0;

    if (!APPLY) {
      console.log(
        `[dry] ${user.name || "?"} <${user.email || "-"}> ` +
          `before=${fmt(beforeBal)} → after=${fmt(beforeBal + AMOUNT)}` +
          (user.isBot ? " [bot]" : "")
      );
      ok += 1;
      continue;
    }

    try {
      await withMongoTransaction(async (session) => {
        await ledgerDeposit({
          session,
          userId: user._id,
          amount: AMOUNT,
          ledgerType: "admin_grant",
          meta: {
            channel: "admin_script",
            reason: "bulk_grant_all_players",
            script: "grantAllPlayersChips.js",
            grantedAmount: AMOUNT,
          },
        });
      });
      const afterWallet = await Wallet.findOne({ user: user._id }).lean();
      const afterBal = afterWallet ? Number(afterWallet.balance || 0) : 0;
      console.log(
        `[ok] ${user.name || "?"} <${user.email || "-"}> ` +
          `${fmt(beforeBal)} → ${fmt(afterBal)}`
      );
      ok += 1;
    } catch (e) {
      failed += 1;
      console.error(`[fail] ${uid} ${user.email || ""}: ${e.message}`);
    }
  }

  console.log("\n--- summary ---");
  console.log(`ok=${ok} failed=${failed} skipped=${skipped}`);
  if (!APPLY) {
    console.log("Dry-run only. Re-run with --apply to credit wallets.");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
