const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const Wallet = require("../models/walletModel");
const MiniGamePlay = require("../models/miniGamePlayModel");

const TYPES = {
  "golden-eagle-slot": { minBet: 1, maxBet: 100, houseEdge: 0.05 },
  "fruit-slot": { minBet: 1, maxBet: 50, houseEdge: 0.04 },
  "thunder-king": { minBet: 2, maxBet: 200, houseEdge: 0.06 },
  "lucky-dice": { minBet: 1, maxBet: 100, houseEdge: 0.03 },
};

exports.listTypes = asyncHandler(async (req, res) => {
  const data = Object.entries(TYPES).map(([type, cfg]) => ({ type, ...cfg }));
  res.status(200).json({ results: data.length, data });
});

function rng() {
  return Math.random();
}

function outcomeForType(type, bet) {
  // Very simple RNG placeholder with house edge
  const cfg = TYPES[type];
  const r = rng();
  let multiplier = 0;
  let result = "";
  if (r < 0.02) {
    multiplier = 10;
    result = "jackpot";
  } else if (r < 0.10) {
    multiplier = 3;
    result = "big_win";
  } else if (r < 0.35) {
    multiplier = 1.5;
    result = "win";
  } else {
    multiplier = 0;
    result = "lose";
  }
  // Apply simple house edge by reducing multiplier slightly
  multiplier = Math.max(0, multiplier - cfg.houseEdge);
  const payout = Math.floor(bet * multiplier);
  return { payout, result };
}

exports.play = asyncHandler(async (req, res, next) => {
  const { type, bet } = req.body;
  const cfg = TYPES[type];
  if (!cfg) return next(new ApiError("Invalid game type", 400));
  const betVal = Number(bet);
  if (isNaN(betVal) || betVal < cfg.minBet || betVal > cfg.maxBet) {
    return next(new ApiError(`Bet must be between ${cfg.minBet} and ${cfg.maxBet}`, 400));
  }

  // Ensure wallet and debit
  let wallet = await Wallet.findOne({ user: req.user._id });
  if (!wallet) wallet = await Wallet.create({ user: req.user._id });
  if (!wallet.hasSufficientBalance(betVal)) {
    return next(new ApiError("Insufficient wallet balance", 400));
  }
  await wallet.addTransaction("debit", betVal, `Side game bet (${type})`);

  // RNG outcome
  const { payout, result } = outcomeForType(type, betVal);
  if (payout > 0) {
    await wallet.addTransaction("credit", payout, `Side game payout (${type}) - ${result}`);
  }

  const play = await MiniGamePlay.create({
    user: req.user._id,
    type,
    bet: betVal,
    payout,
    profit: payout - betVal,
    result,
  });

  res.status(200).json({ status: "success", data: { play, walletBalance: wallet.balance } });
});
