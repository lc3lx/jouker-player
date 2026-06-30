const { codeForReason } = require("./errors/ErrorCodes");

/**
 * ActionPipeline - composable validation stages wrapping mutating socket handlers.
 *
 * Only stages 1-4 of the spec's 8-stage pipeline are implemented as an
 * actual new guard layer here:
 *   1. Authentication        - socket has a verified userId
 *   2. Seat validation        - userId is seated at the room/table
 *   3. Reconnect validation    - forward-looking; default pass-through this phase
 *   4. Game running validation - game instance exists and is not finished
 *
 * Stages 5-6 (Turn validation, Rule validation) intentionally stay inside
 * each game's own applyMove() exactly as today (e.g. Tarneeb41's inline
 * "not_your_turn"/"must_follow_suit" checks) - moving those into a shared
 * pipeline would mean rewriting applyMove itself, out of scope this phase.
 * Stage 7 (Execution) is a named pass-through to game.applyMove(...), not a
 * reimplementation. Stage 8 (Broadcast) stays as each handler's existing
 * broadcast call, unchanged.
 *
 * Usage - wraps an existing handler body, does not replace it:
 *
 *   const result = ActionPipeline.run({ userId, game });
 *   if (!result.ok) {
 *     socket.emit("invalid_move", { reason: result.reason, code: result.code });
 *     return;
 *   }
 *   const moveResult = ActionPipeline.execute(game, result.playerIndex, action, payload);
 */
class ActionPipeline {
  /**
   * @param {object} ctx
   * @param {string|null} ctx.userId - authenticated user id from the socket, or null/undefined if unauthenticated
   * @param {object|null} ctx.game - the game instance (TrixGame/Tarneeb41Game/PokerTable), or null/undefined if not found
   * @param {boolean} [ctx.requireRunning=true] - stage 4: reject if game is missing or already finished
   * @returns {{ ok: true, playerIndex: number } | { ok: false, stage: string, reason: string, code: string }}
   */
  static run({ userId, game, requireRunning = true } = {}) {
    // Stage 1: Authentication
    if (!userId) {
      return ActionPipeline._fail("authentication", "authentication_required");
    }

    // Stage 4 (existence half): Game running validation
    if (!game) {
      return ActionPipeline._fail("game_running", "game_not_found");
    }

    // Stage 2: Seat validation
    const playerIndex = typeof game.getPlayerIndex === "function" ? game.getPlayerIndex(userId) : -1;
    if (playerIndex < 0) {
      return ActionPipeline._fail("seat", "not_seated_at_table");
    }

    // Stage 3: Reconnect validation - no current game gates actions on a
    // reconnect-pending state; default pass-through this phase.

    // Stage 4 (running half): Game running validation
    if (requireRunning && typeof game.isGameFinished === "function" && game.isGameFinished()) {
      return ActionPipeline._fail("game_running", "game_finished");
    }

    return { ok: true, playerIndex };
  }

  static _fail(stage, reason) {
    return { ok: false, stage, reason, code: codeForReason(reason) };
  }

  /** Stage 7: named pass-through to the game's own applyMove - not a reimplementation. */
  static execute(game, playerIndex, action, payload) {
    return game.applyMove(playerIndex, action, payload);
  }
}

module.exports = ActionPipeline;
