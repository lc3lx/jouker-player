"use strict";
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

// Read-only server diagnosis. Never logs the DB URI, credentials or player data.
async function main() {
  const required = ["games/utils/slotOperation.js", "games/utils/slotEconomy.js",
    "games/utils/slotEconomyCalibration.json", "models/slotOperationModel.js",
    "models/goldenTreeBonusSessionModel.js", "models/kingArthBonusSessionModel.js",
    "services/slotProductionSchemaService.js"];
  const missingFiles = required.filter(file => !fs.existsSync(path.join(__dirname, "..", file)));
  console.log(JSON.stringify({ node: process.version, structuredClone: typeof structuredClone === "function", missingFiles }));
  const uri = process.env.DB_URI || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("DB_URI/MONGO_URI/MONGODB_URI is not configured");
  await mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 8000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  const transactionalTopology = !!hello.setName || hello.msg === "isdbgrid";
  console.log(JSON.stringify({ databaseConnected: true, replicaSet: hello.setName || null,
    primary: !!hello.isWritablePrimary, mongos: hello.msg === "isdbgrid", transactionalTopology,
    standaloneHint: String(process.env.MONGO_STANDALONE || ""), appMode: process.env.APP_MODE || "beta" }));
  const collections = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
  for (const name of ["slot_operations", "golden_tree_bonus_sessions", "king_arth_bonus_sessions"]) {
    const present = collections.some(c => c.name === name);
    const indexes = present ? await mongoose.connection.db.collection(name).indexes() : [];
    console.log(JSON.stringify({ collection: name, present, indexes: indexes.map(i => ({ key: i.key, unique: !!i.unique })) }));
  }
  if (!transactionalTopology) {
    console.error("MONGO_REPLICA_SET_REQUIRED: MongoDB is standalone; enable a replica set before financial slot transactions.");
    process.exitCode = 2;
  }
  if (missingFiles.length || typeof structuredClone !== "function") process.exitCode = 2;
}
if (require.main === module) main().catch(err => { console.error(err.codeName || err.code || err.name); process.exitCode = 1; }).finally(() => mongoose.disconnect());
module.exports = { main };
