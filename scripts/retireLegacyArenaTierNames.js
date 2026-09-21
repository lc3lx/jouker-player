/**
 * Clears admin tier-name overrides that still hold a retired placeholder.
 *
 * The house tiers used to be named صغيرة / أكبر بشوي / أكبر / أكبر بكثير /
 * الأكبر. An admin who renamed a tier from the CMS gets a row in
 * ArenaTournamentSettings.tiers, and that row wins over the catalog default
 * forever — so if anybody ever "renamed" a tier to the same placeholder it
 * already showed, the new cup names would never appear for that tier.
 *
 * Only overrides that match a retired name *exactly* are removed. A name the
 * admin actually chose is left alone, whatever it is.
 *
 * Idempotent. Usage: node scripts/retireLegacyArenaTierNames.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const ArenaTournamentSettings = require("../models/arenaTournamentSettingsModel");
const { LEGACY_TIER_NAMES_AR } = require("../services/arenaTournamentCatalog");

async function main() {
  const uri = process.env.DATABASE_URL || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/play";
  await mongoose.connect(uri);

  const doc = await ArenaTournamentSettings.findOne({ key: "default" });
  if (!doc || !Array.isArray(doc.tiers) || doc.tiers.length === 0) {
    console.log("no tier overrides stored — nothing to retire");
    await mongoose.disconnect();
    return;
  }

  const retired = new Set(LEGACY_TIER_NAMES_AR);
  let cleared = 0;

  for (const row of doc.tiers) {
    const name = typeof row.nameAr === "string" ? row.nameAr.trim() : "";
    if (name && retired.has(name)) {
      console.log(`  ${row.id}: clearing "${name}" → catalog default`);
      row.nameAr = undefined;
      cleared += 1;
    }
  }

  // A row whose only content was the retired name carries nothing now.
  doc.tiers = doc.tiers.filter(
    (r) => (r.nameAr && String(r.nameAr).trim()) || Number.isFinite(Number(r.entryFee))
  );

  if (cleared === 0) {
    console.log("no retired names found — every override is one an admin chose");
  } else {
    await doc.save();
    console.log(`cleared ${cleared} retired tier name(s)`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    // already down
  }
  process.exit(1);
});
