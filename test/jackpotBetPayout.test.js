process.env.NODE_ENV = 'test';
process.env.POSEIDON_WALLET_MODE = 'stub';
process.env.ZENOBIA_WALLET_MODE = 'stub';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const service = require('../games/poseidon/jackpot/jackpotService');
const { settleJackpotRound } = require('../games/poseidon/jackpot/jackpotSettlement');
const wallet = require('../games/poseidon/poseidonWalletAdapter');
const zenobiaWallet = require('../games/zenobia/zenobiaWalletAdapter');
const creators = {
  poseidon: service.createJackpotRound,
  'king-arth': require('../games/dice/kingArthJackpot').createRoundForSpin,
  'golden-tree': require('../games/goldenTree/goldenTreeJackpot').createRoundForSpin,
  zenobia: require('../games/zenobia/zenobiaJackpot').createRoundForSpin,
};

for (const [game, create] of Object.entries(creators)) {
  for (const betAmount of [10_000, 100_000, 250_000]) {
    for (const [tier, multiplier] of Object.entries({ super10m: 100, mega50m: 500, grand100m: 1000 })) {
      test(`${game}: ${betAmount} / ${tier} survives recovery and concurrent settlement`, async () => {
        const userId = `${game}-${betAmount}-${tier}`;
        const w = game === 'zenobia' ? zenobiaWallet : wallet;
        w.seedStubBalance(userId, 123);
        const round = await create({ userId, spinId: userId, betAmount });
        assert.ok(round.cards.every(c => c.prize === undefined && c.amount === undefined));
        assert.equal(round.tierAmounts[tier], betAmount * multiplier);
        const stored = service._getStubRounds().get(round.roundId);
        assert.equal(stored.game, game);
        assert.equal(stored.betAmount, betAmount);
        const recovered = await service.recoverJackpotRound(round.roundId, userId);
        assert.deepEqual(recovered.tierAmounts, round.tierAmounts);
        assert.equal(await service.recoverJackpotRound(round.roundId, 'other'), null);
        for (const card of stored.cards.filter(c => c.prize === tier)) {
          const revealed = await service.revealJackpotCard(round.roundId, userId, card.index);
          assert.equal(revealed.card.amount, betAmount * multiplier);
        }
        const results = await Promise.all(Array.from({ length: 5 }, () => settleJackpotRound(round.roundId, userId)));
        assert.ok(results.every(r => r.prizeAmount === betAmount * multiplier));
        assert.ok(results.every(r => r.balance === 123 + betAmount * multiplier));
        assert.equal(await w.getBalance(userId), 123 + betAmount * multiplier);
      });
    }
  }
}

test('legacy round amounts remain authoritative with no bet metadata', async () => {
  const round = await service.createJackpotRound({ userId: 'legacy', spinId: 'old', betAmount: 100_000 });
  const stored = service._getStubRounds().get(round.roundId);
  delete stored.betAmount;
  delete stored.payoutVersion;
  const recovered = await service.recoverJackpotRound(round.roundId, 'legacy');
  assert.equal(recovered.payoutVersion, 1);
  assert.equal(recovered.tierAmounts.grand100m, 100_000_000);
  for (const card of stored.cards.filter(c => c.prize === 'grand100m')) {
    await service.revealJackpotCard(round.roundId, 'legacy', card.index);
  }
  assert.equal((await settleJackpotRound(round.roundId, 'legacy')).prizeAmount, 100_000_000);
});

test('reject missing, nonnumeric, nonpositive and overflowing bets', async () => {
  for (const betAmount of [undefined, null, '10000', 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(service.createJackpotRound({ spinId: 'bad', userId: 'bad', betAmount }), /Invalid jackpot betAmount/);
  }
});
