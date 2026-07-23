/**
 * Tournament health checks: stale clan-tournament matches (the boot-sanitizer
 * gap, TABLE_LIFECYCLE_AUDIT-adjacent finding), escrow drift, and standalone
 * (legacy) Tournament anomalies.
 *
 * The standalone Tournament system's public routes have since been disabled
 * (see docs/STANDALONE_TOURNAMENT_DISABLED.md — routes/tournamentRoute.js no
 * longer reaches its registration/payout code at all, and its scheduler is
 * no longer started from server.js), so new anomalies of this class should
 * no longer occur. checkStandaloneTournaments keeps running as pure
 * defense-in-depth for any documents that predate the disable — still
 * alert-only, never auto-repaired, engine code still untouched.
 */
const ClanTournament = require("../../models/clanTournamentModel");
const ClanTournamentMatch = require("../../models/clanTournamentMatchModel");
const Tournament = require("../../models/tournamentModel");
const Table = require("../../models/tableModel");

function makeFinding({ check, severity, tableId = null, playerId = null, message, meta = {} }) {
  return {
    check,
    severity,
    tableId: tableId ? String(tableId) : null,
    playerId: playerId ? String(playerId) : null,
    socketId: null,
    message,
    meta,
    repaired: false,
    repairAction: null,
    repairResult: null,
  };
}

/**
 * Matches "live" well past their own deadlineAt (the running
 * clanTournamentEngineService.tick() should already have walked these over)
 * or "live" while pointing at an archived/missing table (the crash-recovery
 * gap tableGcService's boot sanitizer now defers instead of corrupting).
 * Repairs by calling the engine's own tick() — idempotent, reuses its exact
 * walkover logic, no new tournament-resolution code.
 */
async function checkStaleClanMatches({ tournamentMatchGraceMs, autoRepairEnabled }) {
  const findings = [];
  const cutoff = new Date(Date.now() - tournamentMatchGraceMs);

  const staleByDeadline = await ClanTournamentMatch.find({
    status: "live",
    advanced: false,
    deadlineAt: { $lt: cutoff },
  })
    .select("tournament round matchIndex tableId deadlineAt")
    .limit(200);

  const liveMatches = await ClanTournamentMatch.find({ status: "live", advanced: false })
    .select("tournament round matchIndex tableId")
    .limit(500);

  const tableIds = liveMatches.map((m) => m.tableId).filter(Boolean);
  const tables = await Table.find({ _id: { $in: tableIds } }).select("status");
  const tableStatusById = new Map(tables.map((t) => [String(t._id), t.status]));

  const orphanedTable = liveMatches.filter((m) => {
    if (!m.tableId) return true;
    const status = tableStatusById.get(String(m.tableId));
    return status == null || status === "archived" || status === "closed";
  });

  const flagged = new Map();
  for (const m of [...staleByDeadline, ...orphanedTable]) {
    flagged.set(String(m._id), m);
  }

  for (const match of flagged.values()) {
    const finding = makeFinding({
      check: "stale_clan_tournament_match",
      severity: "critical",
      tableId: match.tableId,
      message: `ClanTournamentMatch ${match._id} (tournament ${match.tournament}, round ${match.round}) is still "live" but stale or its table is gone`,
      meta: { matchId: String(match._id), tournament: String(match.tournament), round: match.round },
    });

    if (autoRepairEnabled) {
      try {
        const { tick } = require("../clanTournamentEngineService");
        await tick();
        finding.repaired = true;
        finding.repairAction = "clanTournamentEngineService.tick";
        finding.repairResult = "success";
      } catch (e) {
        finding.repaired = false;
        finding.repairAction = "clanTournamentEngineService.tick";
        finding.repairResult = "failed";
        finding.meta.repairError = e?.message || "unknown";
      }
    }
    findings.push(finding);
  }
  return findings;
}

/** escrowHeld must equal sum(participants[].escrow) — alert only, never auto-adjusts money. */
async function checkEscrowDrift() {
  const findings = [];
  const tournaments = await ClanTournament.find({ lifecycle: { $in: ["registering", "seeding", "running"] } })
    .select("escrowHeld participants prizePaid prizePool type")
    .limit(300);

  for (const t of tournaments) {
    const sumEscrow = (t.participants || []).reduce((s, p) => s + (Number(p.escrow) || 0), 0);
    if (sumEscrow !== (Number(t.escrowHeld) || 0)) {
      findings.push(
        makeFinding({
          check: "clan_tournament_escrow_drift",
          severity: "critical",
          message: `ClanTournament ${t._id}: escrowHeld (${t.escrowHeld}) != sum(participants.escrow) (${sumEscrow})`,
          meta: { tournamentId: String(t._id), escrowHeld: t.escrowHeld, sumParticipantEscrow: sumEscrow },
        })
      );
    }
    if (t.type === "paid" && Number(t.prizePaid) > Number(t.escrowHeld)) {
      findings.push(
        makeFinding({
          check: "clan_tournament_overpaid",
          severity: "critical",
          message: `ClanTournament ${t._id}: prizePaid (${t.prizePaid}) exceeds escrowHeld (${t.escrowHeld})`,
          meta: { tournamentId: String(t._id), prizePaid: t.prizePaid, escrowHeld: t.escrowHeld },
        })
      );
    }
  }
  return findings;
}

/**
 * Standalone Tournament system: flag lifecycles stuck well past a reasonable
 * window, and "finished" tournaments whose computed prizes were never paid.
 * Alert-only per product decision — this system's registration/payout code
 * is a known, separately-tracked gap, not something this monitor fixes.
 */
async function checkStandaloneTournaments({ tournamentMatchGraceMs }) {
  const findings = [];
  const cutoff = new Date(Date.now() - Math.max(tournamentMatchGraceMs, 60 * 60 * 1000));

  const stuck = await Tournament.find({
    lifecycle: { $in: ["registering", "late_registration", "running", "breaking", "balancing"] },
    updatedAt: { $lt: cutoff },
  })
    .select("lifecycle startAt updatedAt participants")
    .limit(100);
  for (const t of stuck) {
    findings.push(
      makeFinding({
        check: "standalone_tournament_stuck",
        severity: "warning",
        message: `Standalone Tournament ${t._id} has been in lifecycle "${t.lifecycle}" with no update since ${t.updatedAt?.toISOString?.()}`,
        meta: { tournamentId: String(t._id), lifecycle: t.lifecycle, participantCount: (t.participants || []).length },
      })
    );
  }

  const unpaid = await Tournament.find({ lifecycle: "finished", "prizes.0": { $exists: true } })
    .select("prizes finishedAt")
    .limit(100);
  for (const t of unpaid) {
    findings.push(
      makeFinding({
        check: "standalone_tournament_unpaid_prizes",
        severity: "warning",
        message: `Standalone Tournament ${t._id} finished with computed prizes that are never wired up to be paid (known gap — see docs)`,
        meta: { tournamentId: String(t._id), prizeCount: (t.prizes || []).length },
      })
    );
  }
  return findings;
}

async function run(settings) {
  const [staleMatches, escrowDrift, standalone] = await Promise.all([
    checkStaleClanMatches(settings),
    checkEscrowDrift(),
    checkStandaloneTournaments(settings),
  ]);
  return { findings: [...staleMatches, ...escrowDrift, ...standalone] };
}

module.exports = { run, checkStaleClanMatches, checkEscrowDrift, checkStandaloneTournaments };
