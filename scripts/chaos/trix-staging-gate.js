/* eslint-disable no-console */
/**
 * Trix production ship gate.
 *
 * Local (always):
 *   node scripts/chaos/trix-staging-gate.js
 *   → runs lifecycle + Trix engine unit suites that must be green before ship.
 *
 * Staging chaos (when env is set):
 *   CHAOS_URL=https://staging.example.com/game \
 *   CHAOS_TABLE_ID=<id> CHAOS_GAME=trix \
 *   CHAOS_TOKENS='jwt1,jwt2,jwt3,jwt4' \
 *   node scripts/chaos/trix-staging-gate.js
 *
 * Exit codes:
 *   0 — local suites green; chaos skipped or passed
 *   1 — local suite or chaos failure
 *   2 — chaos requested but env incomplete (local still ran)
 */
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "../..");
const localSuites = [
  "test/lifecycle.repair.test.js",
  "test/trix.gameplay.test.js",
  "test/trix.scoring-e2e.test.js",
  "test/trix.info-isolation.test.js",
  "test/trix.concurrency.test.js",
  "test/trix.rc-verification.test.js",
];

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    windowsHide: true,
    ...opts,
  });
  return r.status ?? 1;
}

console.log("=== Trix production gate — local suites ===");
// Use `node` on PATH so Windows paths with spaces in process.execPath don't break shell.
const localStatus = run("node", ["--test", ...localSuites]);
if (localStatus !== 0) {
  console.error("\nLocal gate FAILED — do not ship.");
  process.exit(localStatus);
}
console.log("\nLocal gate PASS.");

const TABLE_ID = process.env.CHAOS_TABLE_ID || "";
const TOKENS = (process.env.CHAOS_TOKENS || "").trim();
const wantsChaos = !!(TABLE_ID && TOKENS);

console.log("\n=== Staging chaos matrix (manual checklist) ===");
console.log(
  [
    "[ ] 4 concurrent joins → single start, all receive valid gameState",
    "[ ] Leave mid-turn → ACK, no ghost seat, bot continues",
    "[ ] Disconnect → reconnect within grace restores seat",
    "[ ] Disconnect after grace → reconnect_expired + bot",
    "[ ] 409 from second device → lobby recovers to active Trix table",
    "[ ] Kill backend mid-round → recovery/settlement, no stuck wallet lock",
    "[ ] Monitors quiet: checkStuckCardGames / checkSeatWithoutSocket",
  ].join("\n")
);

if (!wantsChaos) {
  console.log(
    "\nChaos skipped (set CHAOS_TABLE_ID + CHAOS_TOKENS to run against staging)."
  );
  console.log(
    "Example:\n  CHAOS_URL=.../game CHAOS_TABLE_ID=... CHAOS_GAME=trix CHAOS_TOKENS=jwt1,jwt2,jwt3,jwt4 node scripts/chaos/lifecycle-chaos.js"
  );
  process.exit(0);
}

process.env.CHAOS_GAME = process.env.CHAOS_GAME || "trix";
console.log("\n=== Running lifecycle-chaos.js ===");
const chaosStatus = run("node", [path.join(__dirname, "lifecycle-chaos.js")]);
if (chaosStatus !== 0) {
  console.error("\nStaging chaos FAILED — do not ship.");
  process.exit(chaosStatus);
}
console.log("\nStaging chaos PASS. Trix gate cleared.");
process.exit(0);
