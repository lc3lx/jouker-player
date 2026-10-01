"use strict";
require("dotenv").config();
const mongoose = require("mongoose");

async function main() {
  const uri = process.env.DB_URI || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("DB_URI is required");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const names = ["poseidonBonusSessionModel", "zenobiaBonusSessionModel", "goldenTreeBonusSessionModel", "kingArthBonusSessionModel", "slotOperationModel"];
  const dryRun = process.argv.includes("--dry-run");
  for (const name of names) {
    const Model = require(`../models/${name}`);
    if (!dryRun) await Model.createIndexes();
    console.log(JSON.stringify({ model: name, indexes: Model.schema.indexes().map(([keys]) => keys), dryRun }));
  }
  // Missing version always means legacy, never silently change an entitlement.
  for (const name of ["poseidonBonusSessionModel", "zenobiaBonusSessionModel", "goldenTreeBonusSessionModel"]) {
    const Model = require(`../models/${name}`);
    const query = { economyVersion: { $exists: false } };
    const count = await Model.countDocuments(query);
    if (!dryRun && count) await Model.updateMany(query, { $set: { economyVersion: 1, revision: 0 } });
    console.log(JSON.stringify({ model: name, legacySessions: count, dryRun }));
  }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
