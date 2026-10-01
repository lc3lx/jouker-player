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
  const version = bonus ? bonus.economyVersion || 1 : economy.VERSION;
  const betAmount = Number(bonus?.betAmount || bonus?.lockedBaseBet || req.query.betAmount || 10000);
  const params = bonusMode || game === "zeus" ? null : edge.calculateEdge({ game, betAmount, userId: null });
  const scale = economy.payScale(game, { bonusMode, superBonus, tierName: params?.tierName, economyVersion: version });
  const folder = game === "golden-tree" ? "goldenTree" : game === "zeus" ? "dice" : game;
  const name = game === "zeus" ? "DiceEngine" : "constants";
  const c = require(`../games/${folder}/${name}${version === 1 ? ".v1" : ""}`);
  const amounts = {};
  for (const [symbol, bands] of Object.entries(c.PAYTABLE)) {
    bands.forEach((raw, i) => {
      let value = game === "poseidon" ? Math.round(raw * 0.78 * 1000) / 1000 : raw;
      if (version === 1 && bonusMode && game === "poseidon") value *= c.BONUS_CLUSTER_SCALE;
      amounts[raw.toFixed(6)] = value * scale;
    });
  }
  res.json({ status: "success", data: { economyVersion: version, bonusMode, superBonus, bonusRtp: economy.BONUS_RTP,
    buyCostMultiplier: c.BUY_BONUS_COST || c.BUY_COST_MULT,
    superBuyCostMultiplier: c.SUPER_BUY_BONUS_COST || c.SUPER_BUY_COST_MULT || null,
    amounts } });
});
