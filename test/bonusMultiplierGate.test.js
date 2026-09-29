const test = require('node:test');
const assert = require('node:assert/strict');
for (const [name, source] of [
  ['zeus', '../games/dice/DiceEngine'],
  ['poseidon', '../games/poseidon/constants'],
  ['zenobia', '../games/zenobia/constants'],
]) {
  test(`${name}: only a fresh multiplier activates the retained bonus bank`, () => {
    const { resolvePayoutMultiplier: resolve } = require(source);
    let carried = 10;
    for (const [win, fresh, applied, bank] of [
      [100, 0, 1, 10], [100, 5, 15, 15], [100, 0, 1, 15],
      [0, 20, 1, 15], [100, 2, 17, 17],
    ]) {
      const result = resolve({ baseWin: win, plaqueSum: fresh, carried, isFreeSpin: true });
      assert.equal(result.applied, applied);
      assert.equal(result.nextCarried, bank);
      carried = result.nextCarried;
    }
  });
}
