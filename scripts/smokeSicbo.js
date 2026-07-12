/**
 * Sic Bo engine smoke: boots the round loop against the local Mongo with a fast
 * cadence and a stub namespace, then watches a couple of full round cycles
 * (open → lock → roll → settle → new round) and prints the emitted events.
 *
 * Run: SICBO_BET_MS=1500 SICBO_RESULT_MS=1200 node scripts/smokeSicbo.js
 */
process.env.SICBO_BET_MS = process.env.SICBO_BET_MS || "1500";
process.env.SICBO_RESULT_MS = process.env.SICBO_RESULT_MS || "1200";

const mongoose = require("mongoose");

async function main() {
  const uri =
    process.env.DB_URI ||
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/game";
  await mongoose.connect(uri);
  console.log("[smoke] mongo connected:", uri);

  const events = [];
  const stubNsp = {
    to() {
      return {
        emit(event, payload) {
          events.push(event);
          const rid = payload && payload.roundId ? String(payload.roundId).slice(-6) : "";
          if (event !== "sicbo:timer") {
            console.log(`[emit] ${event} ${rid}`);
          }
        },
      };
    },
  };

  const { startSicboEngine, stopSicboEngine } = require("../services/sicboService");
  const roundState = require("../games/sicbo/sicboRoundState");
  roundState.resetForTests();

  startSicboEngine({ nsp: stubNsp, redis: null });
  console.log("[smoke] engine started — watching ~7s ...");

  await new Promise((r) => setTimeout(r, 7000));
  stopSicboEngine();

  const SicBoRound = require("../models/sicboRoundModel");
  const settled = await SicBoRound.countDocuments({ status: "SETTLED" });
  const total = await SicBoRound.countDocuments({});
  console.log(`[smoke] rounds created=${total} settled=${settled}`);
  console.log(
    "[smoke] saw phases:",
    ["sicbo:new_round", "sicbo:bet_open", "sicbo:bet_closed", "sicbo:dice_animation", "sicbo:result", "sicbo:round_settled"]
      .filter((e) => events.includes(e))
      .join(", ")
  );

  const ok =
    total >= 1 &&
    settled >= 1 &&
    events.includes("sicbo:new_round") &&
    events.includes("sicbo:dice_animation") &&
    events.includes("sicbo:result") &&
    events.includes("sicbo:round_settled");
  console.log(ok ? "[smoke] PASS ✅" : "[smoke] FAIL ❌");

  await mongoose.disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke] error:", e.message);
  process.exit(1);
});
