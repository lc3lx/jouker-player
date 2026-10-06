#!/usr/bin/env node
"use strict";

/**
 * Reconcile the slot economy stats (slot_economy_stats, written after commit)
 * against the money truth in the wallet ledger. Read-only.
 *
 *   node tool/slotStatsReconcile.js [--days=7] [--game=poseidon]
 *
 * Prints, per game: bets + bonus buys and wins + jackpots from both sources,
 * and the difference. A non-zero gap means stats were lost (e.g. a crash
 * between commit and the stats write) — the ledger is authoritative.
 */

require("dotenv").config({ path: require("node:path").join(__dirname, "../.env") });
const mongoose = require("mongoose");

const SOURCES = {
  poseidon: { spin: ["poseidon"], jackpot: "poseidon_jackpot" },
  zenobia: { spin: ["zenobia"], jackpot: "zenobia_jackpot" },
  zeus: { spin: ["king_arth_spin", "king_arth_buy_bonus"], jackpot: "king_arth_jackpot" },
};

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function ledgerTotals(game, since) {
  const WalletTransaction = require("../models/walletTransactionModel");
  const { spin, jackpot } = SOURCES[game];
  const [row] = await WalletTransaction.aggregate([
    { $match: { createdAt: { $gte: since }, "meta.source": { $in: [...spin, jackpot] }, type: { $in: ["game_loss", "game_win"] } } },
    {
      $group: {
        _id: null,
        staked: { $sum: { $cond: [{ $eq: ["$type", "game_loss"] }, "$amount", 0] } },
        paid: { $sum: { $cond: [{ $eq: ["$type", "game_win"] }, "$amount", 0] } },
      },
    },
  ]);
  return { staked: row?.staked || 0, paid: row?.paid || 0 };
}

async function statsTotals(game, since) {
  const SlotEconomyStat = require("../models/slotEconomyStatModel");
  const [row] = await SlotEconomyStat.aggregate([
    { $match: { game, hour: { $gte: since } } },
    {
      $group: {
        _id: null,
        staked: { $sum: { $add: ["$paidBet", "$buySpend", "$superSpend"] } },
        paid: { $sum: { $add: ["$paidWin", "$naturalWin", "$buyWin", "$superWin", "$jackpotPaidBase", "$jackpotPaidBuy", "$jackpotPaidSuper"] } },
      },
    },
  ]);
  return { staked: row?.staked || 0, paid: row?.paid || 0 };
}

async function main() {
  const days = Number(arg("days", 7));
  const only = arg("game", null);
  // Whole hours only: the current hour's stats may still be landing.
  const since = new Date(Math.floor((Date.now() - days * 86400000) / 3600000) * 3600000);
  await mongoose.connect(process.env.DB_URI || process.env.MONGO_URI);
  let mismatched = 0;
  for (const game of Object.keys(SOURCES).filter((g) => !only || g === only)) {
    const [ledger, stats] = await Promise.all([ledgerTotals(game, since), statsTotals(game, since)]);
    const gapStaked = ledger.staked - stats.staked;
    const gapPaid = ledger.paid - stats.paid;
    if (gapStaked !== 0 || gapPaid !== 0) mismatched += 1;
    console.log(JSON.stringify({ game, since, ledger, stats, gap: { staked: gapStaked, paid: gapPaid } }));
  }
  await mongoose.disconnect();
  if (mismatched) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
