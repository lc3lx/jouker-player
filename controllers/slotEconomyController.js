const asyncHandler = require("express-async-handler");
const economy = require("../games/utils/slotEconomy");
const edge = require("../games/utils/houseEdgeController");

exports.forGame = game => asyncHandler(async (req, res) => {
  const userId = req.user ? String(req.user._id || req.user.id || "") : null;
  let bonus = null;
  if (userId) {
    try {
      if (game === "zeus") {
        bonus = await Promise.race([
          require("../games/dice/kingArthRoundState").getFreeSpinSession(userId, "king-arth"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 350))
        ]).catch(() => null);
      } else {
        const folder = game === "golden-tree" ? "goldenTree" : game;
        const manager = require(`../games/${folder}/roundManager`);
        await Promise.race([
          manager.ensureLoaded(userId),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 350))
        ]).catch(() => null);
        bonus = manager.getBonusSession(userId);
      }
    } catch (_) {
      bonus = null;
    }
  }
  const bonusMode = !!bonus, superBonus = !!bonus?.superBonus;
  const zeus = game === "zeus" ? require("../games/dice/DiceEngine") : null;
  const poseidon = game === "poseidon" ? require("../games/poseidon/constants") : null;
  const version = bonus ? bonus.economyVersion || 1 : zeus?.ECONOMY_VERSION || poseidon?.ECONOMY_VERSION || economy.VERSION;
  const betAmount = Number(bonus?.betAmount || bonus?.lockedBaseBet || req.query.betAmount || 10000);
  const params = bonusMode || game === "zeus" || (game === "poseidon" && version >= 3) ? null : edge.calculateEdge({ game, betAmount, userId: null });
  const scale = (zeus || game === "poseidon") && version >= 3 ? 1 : economy.payScale(game, { bonusMode, superBonus, tierName: params?.tierName, economyVersion: version });
  const folder = game === "golden-tree" ? "goldenTree" : game === "zeus" ? "dice" : game;
  const name = game === "zeus" ? "DiceEngine" : "constants";
  const suffix = version === 1 ? ".v1" : (zeus || game === "poseidon") && version === 2 ? ".v2" : "";
  const c = require(`../games/${folder}/${name}${suffix}`);
  const amounts = {};
  for (const [symbol, bands] of Object.entries(c.PAYTABLE)) {
    bands.forEach((raw, i) => {
      let value = game === "poseidon" && version < 3 ? Math.round(raw * 0.78 * 1000) / 1000 : raw;
      if (version === 1 && bonusMode && game === "poseidon") value *= c.BONUS_CLUSTER_SCALE;
      amounts[raw.toFixed(6)] = value * scale;
    });
  }
  const rules = (zeus || game === "poseidon") && version >= 3 ? {
    payoutRows: Object.entries(c.PAYTABLE).map(([symbol, bands]) => ({
      symbol: typeof symbol === "string" && isNaN(symbol) ? symbol : Number(symbol),
      values: [c.PAY_RULES[symbol].start, c.PAY_RULES[symbol].increment]
    })),
    payoutColumns: ["8", "additional"],
    multiplierValues: c.MULTIPLIER_VALUES,
    multiplierProbabilities: { base: c.BASE_MULTIPLIER_WEIGHTS, bonus: c.BONUS_MULTIPLIER_WEIGHTS, super: c.SUPER_MULTIPLIER_WEIGHTS },
    probabilityUnit: "per_spin", jackpotAppearanceProbability: c.JACKPOT_APPEARANCE_PROBABILITY,
    jackpotWinProbability: c.JACKPOT_WIN_PROBABILITY, naturalBonusProbability: c.NATURAL_BONUS_PROBABILITY,
  } : (zeus ? {
    payoutRows: Object.entries(c.PAYTABLE).map(([symbol, bands]) => ({ symbol: Number(symbol),
      values: bands.map(n => n * scale) })),
    payoutColumns: ["8-9", "10-11", "12+"],
  } : {});
  res.json({ status: "success", data: { economyVersion: version, bonusMode, superBonus, bonusRtp: (zeus || game === "poseidon") && version >= 3 ? null : economy.BONUS_RTP,
    buyCostMultiplier: c.BUY_BONUS_COST || c.BUY_COST_MULT,
    superBuyCostMultiplier: c.SUPER_BUY_BONUS_COST || c.SUPER_BUY_COST_MULT || null,
    amounts, ...rules } });
});
