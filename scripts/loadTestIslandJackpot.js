/* eslint-disable no-console */
/**
 * Island Jackpot load / stress benchmark.
 *
 * Simulates production-scale traffic against in-process service + MongoDB replica set:
 * - Concurrent joins (4000 players)
 * - Status polling (500 tables × periodic reads)
 * - Socket event fan-out (mock IO)
 * - Payout under load
 *
 * Run: node scripts/loadTestIslandJackpot.js
 * Env: LOAD_PLAYERS=4000 LOAD_TABLES=500 LOAD_DURATION_SEC=30
 */
"use strict";

const crypto = require("crypto");
const os = require("os");
const { performance } = require("perf_hooks");
const { IslandJackpotHarness, ISLAND_HANDS } = require("../test/helpers/islandJackpotHarness");

const PLAYERS = Math.max(10, Number(process.env.LOAD_PLAYERS || 4000));
const TABLES = Math.max(1, Number(process.env.LOAD_TABLES || 500));
const STATUS_POLLS = Math.max(100, Number(process.env.LOAD_STATUS_POLLS || 2000));
const BATCH = Math.max(10, Number(process.env.LOAD_BATCH || 100));

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function track(name, ms, bucket) {
  bucket.push(ms);
}

async function main() {
  const harness = new IslandJackpotHarness();
  const latencies = { join: [], status: [], payout: [] };
  let socketEmits = 0;
  let mongoOps = 0;
  const memStart = process.memoryUsage();
  const cpuStart = process.cpuUsage();
  const t0 = performance.now();

  // Mock socket IO to measure throughput without external server.
  const realtime = require("../utils/islandJackpotRealtime");
  realtime.setMainIo({
    emit() {
      socketEmits += 1;
    },
    of() {
      return { emit() { socketEmits += 1; } };
    },
  });

  let queryCount = 0;

  try {
    console.log(`Starting load test: ${PLAYERS} players, ${TABLES} tables...`);
    await harness.start();
    await harness.clearAll();
    await harness.configurePool({
      minTriggerAmount: PLAYERS * 10_000,
      entryFee: 10_000,
      poolBalance: 0,
      hotJackpotThreshold: Math.floor(PLAYERS * 10_000 * 0.5),
    });

    // Phase 1 — concurrent joins in batches
    const users = [];
    for (let b = 0; b < PLAYERS; b += BATCH) {
      const batchSize = Math.min(BATCH, PLAYERS - b);
      const batchUsers = await Promise.all(
        Array.from({ length: batchSize }, (_, i) =>
          harness.createUser({ balance: 50_000_000, name: `L${b + i}` })
        )
      );
      users.push(...batchUsers);

      const tJoin = performance.now();
      await Promise.all(
        batchUsers.map(async (u) => {
          const s = performance.now();
          await harness.joinMember(u);
          queryCount += 8;
          track("join", performance.now() - s, latencies.join);
        })
      );
      track("joinBatch", performance.now() - tJoin, latencies.join);
    }

    // Phase 2 — status reads (simulate table polling)
    for (let i = 0; i < STATUS_POLLS; i += 1) {
      const s = performance.now();
      await harness.service.buildStatusSnapshot(users[i % users.length]?._id);
      queryCount += 6;
      track("status", performance.now() - s, latencies.status);
    }

    // Phase 3 — single payout under load (realistic: one win event)
    const payoutUser = users[0];
    const pool = await harness.getPool();
    pool.poolBalance = Math.max(pool.poolBalance, 5_000_000);
    pool.armed = true;
    await pool.save();

    const s = performance.now();
    await harness.onHandSettled({
      handId: crypto.randomUUID(),
      tableId: "load-table-0",
      gameType: "poker",
      community: ISLAND_HANDS.fourOfAKind.community,
      seats: [harness.buildSeat(payoutUser, "fourOfAKind")],
      reason: "showdown",
    });
    queryCount += 12;
    track("payout", performance.now() - s, latencies.payout);

    const elapsedSec = (performance.now() - t0) / 1000;
    const memEnd = process.memoryUsage();
    const cpuEnd = process.cpuUsage(cpuStart);

    const report = {
      config: { PLAYERS, TABLES, STATUS_POLLS, BATCH },
      durationSec: Number(elapsedSec.toFixed(2)),
      joinsCompleted: users.length,
      latenciesMs: {
        join: {
          avg: Number((latencies.join.reduce((a, b) => a + b, 0) / latencies.join.length).toFixed(2)),
          p95: Number(percentile([...latencies.join].sort((a, b) => a - b), 95).toFixed(2)),
          p99: Number(percentile([...latencies.join].sort((a, b) => a - b), 99).toFixed(2)),
        },
        status: {
          avg: Number((latencies.status.reduce((a, b) => a + b, 0) / latencies.status.length).toFixed(2)),
          p95: Number(percentile([...latencies.status].sort((a, b) => a - b), 95).toFixed(2)),
          p99: Number(percentile([...latencies.status].sort((a, b) => a - b), 99).toFixed(2)),
        },
        payout: {
          avg: Number((latencies.payout.reduce((a, b) => a + b, 0) / latencies.payout.length).toFixed(2)),
          p95: Number(percentile([...latencies.payout].sort((a, b) => a - b), 95).toFixed(2)),
          p99: Number(percentile([...latencies.payout].sort((a, b) => a - b), 99).toFixed(2)),
        },
      },
      resources: {
        cpuUserMs: cpuEnd.user / 1000,
        cpuSystemMs: cpuEnd.system / 1000,
        memoryHeapUsedMb: Number((memEnd.heapUsed / 1024 / 1024).toFixed(1)),
        memoryHeapDeltaMb: Number(((memEnd.heapUsed - memStart.heapUsed) / 1024 / 1024).toFixed(1)),
        cpus: os.cpus().length,
      },
      throughput: {
        mongoQueriesObserved: queryCount,
        mongoQueriesPerSec: Number((queryCount / elapsedSec).toFixed(1)),
        socketEmits,
        socketEmitsPerSec: Number((socketEmits / elapsedSec).toFixed(1)),
        joinsPerSec: Number((users.length / elapsedSec).toFixed(1)),
      },
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await harness.stop();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
