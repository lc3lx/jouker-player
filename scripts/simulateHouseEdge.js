/**
 * House Edge Multi-Tier Simulation & Verification Script
 *
 * Runs Monte-Carlo simulations across Zeus, Poseidon, and Golden Tree
 * for different bet sizes (Min, Medium, High, Whale) to verify:
 * 1. Hit rates and engagement at minimum bets
 * 2. Controlled RTP and house protection at whale bets
 * 3. Multiplier governor behavior
 */

process.env.NODE_ENV = "test";
process.env.ZENOBIA_WALLET_MODE = "stub";
process.env.POSEIDON_WALLET_MODE = "stub";
process.env.GOLDEN_TREE_WALLET_MODE = "stub";

const zenobiaService = require("../games/zenobia/zenobiaService");
const zenobiaWallet = require("../games/zenobia/zenobiaWalletAdapter");
const poseidonService = require("../games/poseidon/poseidonService");
const poseidonWallet = require("../games/poseidon/poseidonWalletAdapter");
const goldenTreeService = require("../games/goldenTree/goldenTreeService");
const goldenTreeWallet = require("../games/goldenTree/goldenTreeWalletAdapter");

async function simulateGame(gameName, service, wallet, bets, spinsPerBet = 1000) {
  console.log(`\n==================================================`);
  console.log(`🎮 Simulating: ${gameName.toUpperCase()}`);
  console.log(`==================================================`);

  for (const bet of bets) {
    const userId = `sim_user_${gameName}_${bet}`;
    wallet.seedStubBalance(userId, 100_000_000_000); // 100B balance

    let totalBet = 0;
    let totalWin = 0;
    let winSpins = 0;
    let maxWinMultiple = 0;

    for (let i = 0; i < spinsPerBet; i++) {
      try {
        const res = await service.executeSpin(userId, bet);
        totalBet += bet;
        const win = Number(res.totalWin) || 0;
        totalWin += win;
        if (win > 0) {
          winSpins++;
          const mult = win / bet;
          if (mult > maxWinMultiple) maxWinMultiple = mult;
        }
      } catch (err) {
        console.error(`Error in spin ${i}:`, err.message);
      }
    }

    const hitRate = ((winSpins / spinsPerBet) * 100).toFixed(1);
    const rtp = ((totalWin / totalBet) * 100).toFixed(1);

    console.log(
      `Bet: ${bet.toLocaleString().padStart(12)} coins | ` +
      `Spins: ${spinsPerBet} | ` +
      `Hit Rate: ${hitRate.padStart(5)}% | ` +
      `Max Win: ${maxWinMultiple.toFixed(1).padStart(6)}x | ` +
      `Realized RTP: ${rtp.padStart(6)}%`
    );
  }
}

async function run() {
  const testBets = [
    10_000,       // Tier 0: Min bet (Hook / Engagement)
    50_000,       // Tier 1: Medium bet
    250_000,      // Tier 2: Controlled bet
    2_000_000,    // Tier 3: Whale bet (House Protection)
  ];

  const SPINS = 800; // Fast simulation

  await simulateGame("Zeus (Zenobia)", zenobiaService, zenobiaWallet, testBets, SPINS);
  await simulateGame("Poseidon", poseidonService, poseidonWallet, testBets, SPINS);
  await simulateGame("Golden Tree", goldenTreeService, goldenTreeWallet, testBets, SPINS);

  console.log(`\n==================================================`);
  console.log(`✅ House Edge Simulation Complete!`);
  console.log(`==================================================\n`);
  process.exit(0);
}

run().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
