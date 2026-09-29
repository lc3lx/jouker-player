async function refreshCardTableCosmeticsForUser(userId, rooms = require('../rooms/roomManager')) {
  for (const games of [rooms.trixGamesByTableId, rooms.tarneeb41GamesByTableId]) {
    for (const game of games.values()) {
      if (!game.players.some((p) => p && String(p.userId) === String(userId))) continue;
      await game.applyCosmeticsToPlayers();
      if (game.notifyStateChanged) game.notifyStateChanged();
      else game._notifyAfterMove({ success: true, cosmeticsChanged: true });
    }
  }
}
module.exports = { refreshCardTableCosmeticsForUser };
