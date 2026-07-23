/**
 * TrixBot - bot decision logic for Trix.
 *
 * Relocated verbatim from games/trix/ai/BotAI.js (no behavior change) as
 * part of the engine/bots/ consolidation alongside TarneebBot.js. The old
 * path now re-exports this module so nothing importing it breaks.
 */
const botBehaviorService = require('../../services/botBehaviorService');

class TrixBot {
  /**
   * @param opts optional { personality, skill, tuning } — when supplied, lower-skill
   *   bots occasionally pick a random valid card (a believable mistake) and
   *   aggressive personalities lead higher. With NO opts the behavior is IDENTICAL
   *   to before (every existing call site is unaffected).
   */
  static botChooseCard(gameState, playerIndex, validCards, opts = null) {
    if (!validCards || validCards.length === 0) return null;

    // Skill-based misplay: return a random legal card instead of the heuristic pick.
    if (opts && opts.skill && botBehaviorService.shouldMisplay(opts.skill, opts.tuning)) {
      return validCards[Math.floor(botBehaviorService.rand01() * validCards.length)];
    }

    const gameType = gameState.currentGameType;

    // Aggressive/veteran personalities lead with a higher card in trick games.
    const leadAggro = opts && opts.tuning ? (opts.tuning.leadAggro || 0) : 0;
    if (
      gameType !== 'Trix' &&
      gameState.tableCards.length === 0 &&
      leadAggro > 0.4 &&
      botBehaviorService.rand01() < leadAggro
    ) {
      return [...validCards].sort((a, b) => b.value - a.value)[0];
    }

    if (gameType === 'Trix') {
      // In Trix, J opens each suit chain.
      const jacks = validCards.filter(c => c.rank === 'J');
      if (jacks.length > 0) return jacks[0];
      return validCards[0];
    }

    // Trick games
    const leadingSuit = gameState.leadingSuit;
    const isLeading = gameState.tableCards.length === 0;

    if (isLeading) {
      // Lead with lowest card to avoid winning
      const sorted = [...validCards].sort((a, b) => a.value - b.value);
      return sorted[0];
    }

    const mustFollowSuit = validCards[0].suit === leadingSuit;

    if (mustFollowSuit) {
      // play lowest card to avoid winning if penalty game
      const sorted = [...validCards].sort((a, b) => a.value - b.value);
      return sorted[0];
    } else {
      // cannot follow suit -> discard worst card based on game type
      if (gameType === 'Diamonds') {
         const diamonds = validCards.filter(c => c.suit === 'Diamonds');
         if (diamonds.length > 0) {
            return diamonds.sort((a, b) => b.value - a.value)[0]; // throw highest diamond
         }
      } else if (gameType === 'Queens') {
         const queens = validCards.filter(c => c.rank === 'Q');
         if (queens.length > 0) return queens[0];
      } else if (gameType === 'KingOfHearts') {
         const kingOfHearts = validCards.find(c => c.rank === 'K' && c.suit === 'Hearts');
         if (kingOfHearts) return kingOfHearts;
      }

      // otherwise throw highest card
      const sorted = [...validCards].sort((a, b) => b.value - a.value);
      return sorted[0];
    }
  }

  static botChooseGame(gameState, playerIndex, availableGames) {
    // Just pick the first available game
    return availableGames[0];
  }
}

module.exports = TrixBot;
