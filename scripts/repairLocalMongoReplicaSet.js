"use strict";
// Run on the Linux host, from the deployed backend directory. No balance edits.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const run = (cmd, args, env) => execFileSync(cmd, args, { env: env || process.env, stdio: "pipe" }).toString();
const modelNames = ["poseidonBonusSessionModel", "zenobiaBonusSessionModel", "goldenTreeBonusSessionModel", "kingArthBonusSessionModel", "slotOperationModel", "poseidonJackpotRoundModel", "miniGamePlayModel"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (process.platform !== "linux" || process.getuid() !== 0) throw new Error("LINUX_ROOT_REQUIRED");
  if (!process.argv.includes("--apply")) throw new Error("PASS_--apply_TO_RUN_REPAIR");
  const envPath = path.resolve(".env");
  const text = fs.readFileSync(envPath, "utf8");
  const fileEnv = dotenv.parse(text);
  const apps = JSON.parse(run("pm2", ["jlist"]));
  const app = apps.find(x => x.name === "backend_pok");
  if (!app || fs.realpathSync(app.pm2_env.pm_cwd) !== fs.realpathSync(process.cwd())) throw new Error("BACKEND_POK_DIRECTORY_MISMATCH");
  const effective = { ...fileEnv, ...app.pm2_env };
  const uri = effective.DB_URI || effective.MONGO_URI || effective.MONGODB_URI || "mongodb://127.0.0.1:27017/game";
  const url = new URL(uri);
  if (url.protocol !== "mongodb:" || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("LOCAL_MONGODB_URI_REQUIRED");
  for (const name of modelNames) require.resolve(`../models/${name}`);
  const confPath = "/etc/mongod.conf";
  const conf = fs.readFileSync(confPath, "utf8");
  if (/^replication\s*:/m.test(conf)) throw new Error("REPLICATION_ALREADY_CONFIGURED_CHECK_FIRST");
  const probe = new mongoose.mongo.MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 10000 });
  let options;
  try {
    await probe.connect();
    const hello = await probe.db("admin").command({ hello: 1 });
    if (hello.setName || hello.msg === "isdbgrid") throw new Error("DATABASE_ALREADY_REPLICATED");
    options = await probe.db("admin").command({ getCmdLineOpts: 1 });
  } finally { await probe.close(); }
  const parsed = options.parsed;
  if (parsed.config !== confPath || parsed.security?.authorization === "enabled" || parsed.security?.keyFile || parsed.security?.transitionToAuth) throw new Error("CONFIG_OR_AUTH_REQUIRES_SEPARATE_SETUP");
  const port = Number(parsed.net?.port || 27017);
  if (port !== Number(url.port || 27017) || !parsed.storage?.dbPath) throw new Error("LOCAL_SERVICE_CONFIG_MISMATCH");
  const dbPath = fs.realpathSync(parsed.storage.dbPath);
  if (dbPath === "/" || dbPath === "/root") throw new Error("INVALID_DB_PATH");
  const backup = `/root/mongo-repair-${Date.now()}`;
  fs.mkdirSync(backup, { mode: 0o700 });
  const size = Number(run("du", ["-sb", dbPath]).split(/\s+/)[0]);
  const stat = fs.statfsSync(backup);
  if (stat.bavail * stat.bsize < size * 1.2) throw new Error("BACKUP_DISK_SPACE_INSUFFICIENT");
  fs.copyFileSync(confPath, path.join(backup, "mongod.conf"));
  fs.copyFileSync(envPath, path.join(backup, "backend.env"));
  console.log(`Backup: ${backup}. Stopping MongoDB briefly for a consistent full copy.`);
  run("pm2", ["stop", "backend_pok"]);
  try {
    run("systemctl", ["stop", "mongod"]);
    run("cp", ["-a", "--", dbPath, path.join(backup, "data")]);
    fs.writeFileSync(confPath, `${conf.trimEnd()}\n\nreplication:\n  replSetName: rs0\n`);
    run("systemctl", ["start", "mongod"]);
  } catch (err) {
    fs.writeFileSync(confPath, conf);
    run("systemctl", ["restart", "mongod"]);
    run("pm2", ["restart", "backend_pok"]);
    throw err;
  }
  // A direct connection is necessary while the new replica set has no primary.
  const client = new mongoose.mongo.MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const admin = client.db("admin");
    await admin.command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `localhost:${port}` }] } });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      const h = await admin.command({ hello: 1 });
      if (h.setName === "rs0" && h.isWritablePrimary) { ready = true; break; }
      await pause(1000);
    }
    if (!ready) throw new Error("PRIMARY_NOT_READY_BACKEND_REMAINS_STOPPED");
  } finally { await client.close(); }
  url.searchParams.set("replicaSet", "rs0");
  url.searchParams.delete("directConnection");
  const newUri = url.toString();
  await mongoose.connect(newUri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
  try {
    for (const name of modelNames) {
      const Model = require(`../models/${name}`);
      await Model.createCollection();
      await Model.createIndexes();
    }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await mongoose.connection.db.collection("wallets").findOne({}, { session });
      });
    } finally { await session.endSession(); }
  } finally { await mongoose.disconnect(); }
  let updated = text;
  const additions = { DB_URI: newUri, MONGO_STANDALONE: "false", REQUIRE_MONGO_TRANSACTIONS: "true" };
  for (const [key, value] of Object.entries(additions)) {
    updated = updated.replace(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, "gm"), "");
    updated += `\n${key}=${JSON.stringify(value)}\n`;
  }
  fs.writeFileSync(envPath, updated);
  run("pm2", ["restart", "backend_pok", "--update-env"], { ...process.env, ...additions });
  console.log("REPLICA_SET_READY / TRANSACTION_OK / SLOT_INDEXES_READY / BACKEND_RESTARTED");
  console.log("Next: pm2 logs backend_pok --lines 60 --nostream");
}

if (require.main === module) main().catch(err => {
  // Driver errors can contain connection strings; print only non-secret codes.
  console.error("Repair stopped:", /^[A-Z_]+$/.test(err.message) ? err.message : (err.codeName || err.name));
  console.error("Inspect mongod status and the backup directory; do not delete any database files.");
  process.exitCode = 1;
});
