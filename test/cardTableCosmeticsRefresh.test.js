const test = require('node:test');
const assert = require('node:assert/strict');
const { refreshCardTableCosmeticsForUser } = require('../services/cardTableCosmeticsRefresh');
test('equipping refreshes both card games and broadcasts after resolution only', async () => {
  const events = [];
  const trix = { players: [{ userId: 'u' }], async applyCosmeticsToPlayers() { events.push('trix-resolve'); }, notifyStateChanged() { events.push('trix-publish'); } };
  const tarneeb = { players: [{ userId: 'u' }], async applyCosmeticsToPlayers() { events.push('tarneeb-resolve'); }, _notifyAfterMove(result) { assert.deepEqual(result, { success: true, cosmeticsChanged: true }); events.push('tarneeb-publish'); } };
  const other = { players: [{ userId: 'other' }], applyCosmeticsToPlayers() { throw Error('wrong table'); } };
  await refreshCardTableCosmeticsForUser('u', { trixGamesByTableId: new Map([[1, trix], [2, other]]), tarneeb41GamesByTableId: new Map([[1, tarneeb]]) });
  assert.deepEqual(events, ['trix-resolve', 'trix-publish', 'tarneeb-resolve', 'tarneeb-publish']);
});
