const asyncHandler = require("express-async-handler");
const economy = require("../games/utils/slotEconomy");
const edge = require("../games/utils/houseEdgeController");

exports.forGame = game => asyncHandler(async (req, res) => {
  const userId = String(req.user._id || req.user.id);
  let bonus;
  if (game === "zeus") {
    bonus = await require("../games/dice/kingArthRoundState").getFreeSpinSession(userId, "king-arth");
  } else {
    const folder = game === "golden-tree" ? "goldenTree" : game;
    const manager = require(`../games/${folder}/roundManager`);
    await manager.ensureLoaded(userId);
    bonus = manager.getBonusSession(userId);
  }
  const bonusMode = !!bonus, superBonus = !!bonus?.superBonus;
  const zeus = game === "zeus" ? require("../games/dice/DiceEngine") : null;
  const version = bonus ? bonus.economyVersion || 1 : zeus?.ECONOMY_VERSION || economy.VERSION;
  const betAmount = Number(bonus?.betAmount || bonus?.lockedBaseBet || req.query.betAmount || 10000);
  const params = bonusMode || game === "zeus" ? null : edge.calculateEdge({ game, betAmount, userId: null });
  const scale = zeus && version >= 3 ? 1 : economy.payScale(game, { bonusMode, superBonus, tierName: params?.tierName, economyVersion: version });
  const folder = game === "golden-tree" ? "goldenTree" : game === "zeus" ? "dice" : game;
  const name = game === "zeus" ? "DiceEngine" : "constants";
  const suffix = version === 1 ? ".v1" : zeus && version === 2 ? ".v2" : "";
  const c = require(`../games/${folder}/${name}${suffix}`);
  const amounts = {};
  for (const [symbol, bands] of Object.entries(c.PAYTABLE)) {
    bands.forEach((raw, i) => {
      let value = game === "poseidon" ? Math.round(raw * 0.78 * 1000) / 1000 : raw;
      if (version === 1 && bonusMode && game === "poseidon") value *= c.BONUS_CLUSTER_SCALE;
      amounts[raw.toFixed(6)] = value * scale;
    });
  }
  const zeusRules = zeus ? {
    payoutRows: Object.entries(c.PAYTABLE).map(([symbol, bands]) => ({ symbol: Number(symbol),
      values: version >= 3 ? [c.PAY_RULES[symbol].start, c.PAY_RULES[symbol].increment] : bands.map(n => n * scale) })),
    payoutColumns: version >= 3 ? ["8", "additional"] : ["8-9", "10-11", "12+"],
    ...(version >= 3 ? {
      multiplierValues: c.MULTIPLIER_VALUES,
      multiplierProbabilities: { base: c.BASE_MULTIPLIER_WEIGHTS, bonus: c.BONUS_MULTIPLIER_WEIGHTS, super: c.SUPER_MULTIPLIER_WEIGHTS },
      probabilityUnit: "per_spin", jackpotAppearanceProbability: c.JACKPOT_APPEARANCE_PROBABILITY,
      jackpotWinProbability: c.JACKPOT_WIN_PROBABILITY, naturalBonusProbability: c.NATURAL_BONUS_PROBABILITY,
    } : {}),
  } : {};
  res.json({ status: "success", data: { economyVersion: version, bonusMode, superBonus, bonusRtp: zeus && version >= 3 ? null : economy.BONUS_RTP,
    buyCostMultiplier: c.BUY_BONUS_COST || c.BUY_COST_MULT,
    superBuyCostMultiplier: c.SUPER_BUY_BONUS_COST || c.SUPER_BUY_COST_MULT || null,
    amounts, ...zeusRules } });
});
