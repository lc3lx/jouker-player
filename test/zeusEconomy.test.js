const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../games/dice/DiceEngine');

for (const superBonus of [false, true]) {
  test(`Zeus ${superBonus ? 'super' : 'standard'} purchase return matches its price`, () => {
    const rounds = 10000;
    const bet = 10000;
    let returned = 0;
    let multiplierRounds = 0;
    for (let round = 0; round < rounds; round++) {
      let left = engine.FREE_SPINS_BOUGHT;
      let bank = 0;
      let won = 0;
      let activated = false;
      for (let spin = 0; left > 0 && won < bet * engine.MAX_WIN_MULTIPLIER; spin++) {
        assert.ok(spin < 1000, 'bonus session must terminate');
        const outcome = engine.spin(bet, {
          serverSeed: `economy-${round}-${spin}`, clientSeed: 'regression', nonce: spin,
          isFreeSpin: true, superBonus, freeSpinMultiplier: bank,
        });
        won = Math.min(won + outcome.totalWin, bet * engine.MAX_WIN_MULTIPLIER);
        bank = outcome.multipliers.freeSpinTotal;
        activated ||= outcome.multipliers.applied > 1;
        if (outcome.scatterCount >= engine.RETRIGGER_MIN_SCATTER) {
          left = Math.min(50, left + engine.RETRIGGER_AWARD);
        }
        left--;
      }
      returned += won;
      if (activated) multiplierRounds++;
    }
    const price = superBonus ? engine.SUPER_BUY_COST_MULT : engine.BUY_COST_MULT;
    const rtp = returned / rounds / bet / price;
    assert.ok(Math.abs(rtp - 0.965) < 0.12, `RTP ${rtp}`);
    assert.ok(multiplierRounds / rounds > 0.6, 'most purchases should activate a multiplier');
  });
}
