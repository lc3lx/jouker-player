const asyncHandler = require("express-async-handler");
const economy = require("../games/utils/slotEconomy");
const edge = require("../games/utils/houseEdgeController");

const PROFILE_GAMES = new Set(["poseidon", "zeus", "zenobia"]);

/**
 * GET /api/{poseidon,zenobia,king-arth,golden-tree}/economy
 *
 * Everything the client needs to show honest prices and rules. A player in a
 * bonus round sees the rules that round was opened under (its pinned engine
 * version / profile); otherwise the game's current economy is described. For
 * profile-driven games the buy prices here are authoritative — the server
 * rejects a purchase whose expectedCost differs (409 price_changed).
 */

async function activeBonus(game, userId) {
  if (!userId) return null;
  const timeout = () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 350));
  try {
    if (game === "zeus") {
      return await Promise.race([
        require("../games/dice/kingArthRoundState").getFreeSpinSession(userId, "king-arth"),
        timeout(),
      ]);
    }
    const folder = game === "golden-tree" ? "goldenTree" : game;
    const manager = require(`../games/${folder}/roundManager`);
    await Promise.race([manager.ensureLoaded(userId), timeout()]).catch(() => null);
    return manager.getBonusSession(userId);
  } catch (_) {
    return null;
  }
}

/** The fixed published paytable of a profile-driven game (same in every profile). */
function profilePaytable(game) {
  if (game === "zenobia") {
    const c = require("../games/zenobia/constants");
    const amounts = {};
    const payoutRows = Object.entries(c.PAYTABLE).map(([symbol, bands]) => {
      const values = bands.slice(c.MIN_ROUTE);
      for (const v of values) amounts[v.toFixed(6)] = v; // the engine pays the table as printed
      return { symbol, values };
    });
    return { amounts, payoutRows, payoutColumns: ["4", "5", "6"] };
  }
  const c = game === "zeus" ? require("../games/dice/DiceEngine") : require("../games/poseidon/constants");
  return {
    amounts: {},
    payoutRows: Object.entries(c.PAY_RULES).map(([symbol, rule]) => ({
      symbol: game === "zeus" ? Number(symbol) : symbol,
      values: [rule.start, rule.increment],
    })),
    payoutColumns: ["8", "additional"],
  };
}

function profilePayload(game, profile) {
  const p = profile.params;
  const zenobia = game === "zenobia";
  const toPercent = (table) => {
    if (!zenobia) return table;
    const sum = table.reduce((a, b) => a + b, 0);
    return table.map((w) => (sum > 0 ? Number(((w / sum) * 100).toFixed(6)) : 0));
  };
  return {
    economyVersion: profile.economyVersion,
    profileId: profile.id,
    targetRtp: profile.targetRtp,
    bonusRtp: profile.measured.buy.standardRtp,
    buyCostMultiplier: profile.buy.standardCost,
    superBuyCostMultiplier: profile.buy.superCost,
    rules: { ...profile.rules },
    measured: {
      rtp: profile.measured.rtp,
      hitRate: profile.measured.hitRate,
      winAtLeastBetRate: profile.measured.winAtLeastBetRate,
      plaqueVisibleRate: profile.measured.plaqueVisibleRate,
      freeSpinsOneIn: profile.measured.freeSpinsOneIn,
      jackpotOneIn: profile.measured.jackpotOneIn,
      standardBuyRtp: profile.measured.buy.standardRtp,
      superBuyRtp: profile.measured.buy.superRtp,
    },
    multiplierValues: p.plaques.values,
    multiplierProbabilities: { base: toPercent(p.plaques.base), bonus: toPercent(p.plaques.bonus), super: toPercent(p.plaques.super) },
    // Poseidon/Zeus: absolute % of spins showing that plaque. Zenobia: % of
    // plaques that carry that face (plaques land per cell).
    probabilityUnit: zenobia ? "per_plaque" : "per_spin",
    jackpotAppearanceProbability: p.jackpot.appearance ?? null,
    jackpotWinProbability: p.jackpot.win,
    naturalBonusProbability: p.naturalBonusProbability,
    ...profilePaytable(game),
  };
}

/** Legacy (pre-profile) economy of an engine version — unchanged rules text. */
function legacyPayload(game, { bonus, betAmountQuery }) {
  const bonusMode = !!bonus;
  const superBonus = !!bonus?.superBonus;
  const zeus = game === "zeus" ? require("../games/dice/DiceEngine") : null;
  const poseidon = game === "poseidon" ? require("../games/poseidon/constants") : null;
  const zenobia = game === "zenobia";
  const version = bonus
    ? bonus.economyVersion || 1
    : zeus?.ECONOMY_VERSION || poseidon?.ECONOMY_VERSION || (zenobia ? 2 : economy.VERSION);
  const betAmount = Number(bonus?.betAmount || bonus?.lockedBaseBet || betAmountQuery || 10000);
  const params = bonusMode || zeus || zenobia || (poseidon && version >= 3)
    ? null
    : edge.calculateEdge({ game, betAmount, userId: null });
  // Zenobia's engine has never applied a pay scale: show the table it pays.
  const scale = zenobia || ((zeus || poseidon) && version >= 3)
    ? 1
    : economy.payScale(game, { bonusMode, superBonus, tierName: params?.tierName, economyVersion: version });
  const folder = game === "golden-tree" ? "goldenTree" : zeus ? "dice" : game;
  const name = zeus ? "DiceEngine" : "constants";
  const suffix = zenobia
    ? ""
    : zeus && version === 3 ? ".v3" : version === 1 ? ".v1" : (zeus || poseidon) && version === 2 ? ".v2" : "";
  const c = require(`../games/${folder}/${name}${suffix}`);
  const amounts = {};
  for (const bands of Object.values(c.PAYTABLE)) {
    bands.forEach((raw) => {
      let value = poseidon && version < 3 ? Math.round(raw * 0.78 * 1000) / 1000 : raw;
      if (version === 1 && bonusMode && poseidon) value *= c.BONUS_CLUSTER_SCALE;
      amounts[raw.toFixed(6)] = value * scale;
    });
  }
  const rules = (zeus || poseidon) && version >= 3 ? {
    payoutRows: Object.entries(c.PAYTABLE).map(([symbol]) => ({
      symbol: Number.isNaN(Number(symbol)) ? symbol : Number(symbol),
      values: [c.PAY_RULES[symbol].start, c.PAY_RULES[symbol].increment],
    })),
    payoutColumns: ["8", "additional"],
    multiplierValues: c.MULTIPLIER_VALUES,
    multiplierProbabilities: { base: c.BASE_MULTIPLIER_WEIGHTS, bonus: c.BONUS_MULTIPLIER_WEIGHTS, super: c.SUPER_MULTIPLIER_WEIGHTS },
    probabilityUnit: "per_spin",
    jackpotAppearanceProbability: c.JACKPOT_APPEARANCE_PROBABILITY,
    jackpotWinProbability: c.JACKPOT_WIN_PROBABILITY,
    naturalBonusProbability: c.NATURAL_BONUS_PROBABILITY,
  } : zeus ? {
    payoutRows: Object.entries(c.PAYTABLE).map(([symbol, bands]) => ({ symbol: Number(symbol), values: bands.map((n) => n * scale) })),
    payoutColumns: ["8-9", "10-11", "12+"],
  } : {};
  return {
    economyVersion: version,
    profileId: null,
    bonusRtp: zeus && version >= 4 ? c.TARGET_RTP.bonus : (zeus || poseidon) && version >= 3 ? null : zenobia ? null : economy.BONUS_RTP,
    ...(zeus && version >= 4 ? { targetRtp: c.TARGET_RTP } : {}),
    buyCostMultiplier: c.BUY_BONUS_COST || c.BUY_COST_MULT,
    superBuyCostMultiplier: c.SUPER_BUY_BONUS_COST || c.SUPER_BUY_COST_MULT || null,
    ...(poseidon ? { standardBuyPaused: !!poseidon.STANDARD_BUY_PAUSED } : {}),
    amounts,
    ...rules,
  };
}

exports.forGame = (game) => asyncHandler(async (req, res) => {
  const userId = req.user ? String(req.user._id || req.user.id || "") : null;
  const bonus = await activeBonus(game, userId);
  const flags = { bonusMode: !!bonus, superBonus: !!bonus?.superBonus };

  if (!PROFILE_GAMES.has(game)) {
    return res.json({ status: "success", data: { ...legacyPayload(game, { bonus, betAmountQuery: req.query.betAmount }), ...flags } });
  }

  const registry = require("../games/slotProfiles/registry");
  const settingsService = require("../services/slotEconomySettingsService");
  const settings = settingsService.getSettings(game);
  const settingsData = {
    economyLive: settings.economyLive,
    enabled: settings.enabled,
    buyEnabled: settings.buyEnabled,
    superBuyEnabled: settings.superBuyEnabled,
    minBet: settings.minBet,
    maxBet: settings.maxBet,
    revision: settings.revision,
  };
  const pinnedToProfile = bonus && (bonus.economyVersion || 0) >= registry.ENGINE_VERSIONS[game] && bonus.profileId;
  let described;
  if (pinnedToProfile) described = profilePayload(game, registry.getProfile(bonus.profileId));
  else if (!bonus && settings.economyLive) described = profilePayload(game, settingsService.activeProfile(game));
  else described = legacyPayload(game, { bonus, betAmountQuery: req.query.betAmount });

  // Prices the player can act on now always come from the live economy.
  const prices = settings.economyLive
    ? (() => {
      const active = settingsService.activeProfile(game);
      return { activeProfileId: active.id, buyCostMultiplier: active.buy.standardCost, superBuyCostMultiplier: active.buy.superCost };
    })()
    : {};
  return res.json({ status: "success", data: { ...described, ...settingsData, ...flags, ...prices } });
});
