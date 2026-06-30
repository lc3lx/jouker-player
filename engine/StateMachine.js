/**
 * StateMachine - small reusable FSM helper.
 *
 * Used as a parallel mirror alongside each game's existing bare-string
 * `this.state` field (see engine/states/*.js) - it is an enforcement/audit
 * layer, not a replacement for the existing string field, which stays as
 * the read API for getGameState()/tests/etc.
 *
 * `transitions` is a plain object: { [fromState]: Set<string> | string[] }
 * listing allowed next states. Same-state transitions are always allowed
 * and no-op (mirrors PokerTable.setRound()'s existing idempotent behavior).
 */
class StateMachine {
  constructor(initialState, transitions, { onIllegal } = {}) {
    this.state = initialState;
    this._transitions = {};
    for (const [from, tos] of Object.entries(transitions || {})) {
      this._transitions[from] = tos instanceof Set ? tos : new Set(tos);
    }
    this._onIllegal =
      typeof onIllegal === "function"
        ? onIllegal
        : (from, to) => {
            throw new Error(`Illegal state transition: ${from} -> ${to}`);
          };
  }

  can(next) {
    if (next === this.state) return true;
    const allowed = this._transitions[this.state];
    return !!allowed && allowed.has(next);
  }

  /** Returns true if the transition was applied (or was a same-state no-op), false if illegal and onIllegal swallowed it. */
  transition(next) {
    if (next === this.state) return true;
    if (this.can(next)) {
      this.state = next;
      return true;
    }
    const result = this._onIllegal(this.state, next);
    if (result === true) {
      this.state = next;
      return true;
    }
    return false;
  }

  getState() {
    return this.state;
  }
}

module.exports = StateMachine;
