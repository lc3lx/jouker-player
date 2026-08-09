/**
 * ErrorCodes - unified error code constants.
 *
 * Wiring is additive, not a replacement: existing handlers emit free-text
 * `reason` strings the Flutter client may already pattern-match on. Handlers
 * should add a new `code` field alongside the existing `reason` field, never
 * replace it. REASON_TO_CODE below maps today's verified reason strings
 * (grepped from socket/handlers/game.handlers.js, games/tarneeb41/, and
 * games/tarneeb/) onto one of the 9 codes; ActionPipeline stages 1-4 emit
 * codes natively since they're new logic with no legacy reason string.
 */
const ErrorCodes = Object.freeze({
  ERR_NOT_SEATED: "ERR_NOT_SEATED",
  ERR_INVALID_ACTION: "ERR_INVALID_ACTION",
  ERR_NOT_YOUR_TURN: "ERR_NOT_YOUR_TURN",
  ERR_GAME_FINISHED: "ERR_GAME_FINISHED",
  ERR_RECONNECT_TIMEOUT: "ERR_RECONNECT_TIMEOUT",
  ERR_TABLE_FULL: "ERR_TABLE_FULL",
  ERR_BUYIN_FAILED: "ERR_BUYIN_FAILED",
  ERR_ALREADY_PLAYING: "ERR_ALREADY_PLAYING",
  ERR_PERMISSION_DENIED: "ERR_PERMISSION_DENIED",
});

/** Existing free-text `reason` string -> one of the 9 codes above. */
const REASON_TO_CODE = {
  // auth / seating
  authentication_required: ErrorCodes.ERR_PERMISSION_DENIED,
  not_seated_at_table: ErrorCodes.ERR_NOT_SEATED,
  not_in_room: ErrorCodes.ERR_NOT_SEATED,
  not_in_tarneeb41_room: ErrorCodes.ERR_NOT_SEATED,
  not_ready: ErrorCodes.ERR_NOT_SEATED,

  // table / lookup
  table_not_found: ErrorCodes.ERR_INVALID_ACTION,
  not_trix_table: ErrorCodes.ERR_INVALID_ACTION,
  not_tarneeb41_table: ErrorCodes.ERR_INVALID_ACTION,
  game_not_found: ErrorCodes.ERR_INVALID_ACTION,
  tableId_required: ErrorCodes.ERR_INVALID_ACTION,
  "tableId required": ErrorCodes.ERR_INVALID_ACTION,

  // turn / phase
  not_your_turn: ErrorCodes.ERR_NOT_YOUR_TURN,
  "not your turn": ErrorCodes.ERR_NOT_YOUR_TURN,
  not_king: ErrorCodes.ERR_PERMISSION_DENIED,
  "not king": ErrorCodes.ERR_PERMISSION_DENIED,
  not_bidding: ErrorCodes.ERR_INVALID_ACTION,
  not_playing: ErrorCodes.ERR_INVALID_ACTION,
  not_round_end: ErrorCodes.ERR_INVALID_ACTION,
  game_finished: ErrorCodes.ERR_GAME_FINISHED,
  not_choosing_trump: ErrorCodes.ERR_INVALID_ACTION,
  only_declarer_chooses: ErrorCodes.ERR_PERMISSION_DENIED,
  trick_resolving: ErrorCodes.ERR_INVALID_ACTION,
  already_declared: ErrorCodes.ERR_ALREADY_PLAYING,
  already_bid_or_passed: ErrorCodes.ERR_ALREADY_PLAYING,
  invalid_state_transition: ErrorCodes.ERR_INVALID_ACTION,
  invalid_state: ErrorCodes.ERR_INVALID_ACTION,
  invalid_game_selection: ErrorCodes.ERR_INVALID_ACTION,
  "invalid game selection": ErrorCodes.ERR_INVALID_ACTION,
  invalid_action_or_state: ErrorCodes.ERR_INVALID_ACTION,
  "invalid action or state": ErrorCodes.ERR_INVALID_ACTION,

  // move/card validation
  invalid_card: ErrorCodes.ERR_INVALID_ACTION,
  card_not_in_hand: ErrorCodes.ERR_INVALID_ACTION,
  "card not in hand": ErrorCodes.ERR_INVALID_ACTION,
  card_required: ErrorCodes.ERR_INVALID_ACTION,
  must_follow_suit: ErrorCodes.ERR_INVALID_ACTION,
  invalid_card_to_play: ErrorCodes.ERR_INVALID_ACTION,
  "invalid card to play": ErrorCodes.ERR_INVALID_ACTION,
  invalid_declare: ErrorCodes.ERR_INVALID_ACTION,
  invalid_bid: ErrorCodes.ERR_INVALID_ACTION,
  invalid_trump: ErrorCodes.ERR_INVALID_ACTION,
  cannot_pass_without_bid: ErrorCodes.ERR_INVALID_ACTION,
  unknown_action: ErrorCodes.ERR_INVALID_ACTION,
  sum_below_min: ErrorCodes.ERR_INVALID_ACTION,
  trick_error: ErrorCodes.ERR_INVALID_ACTION,

  // lifecycle
  start_failed: ErrorCodes.ERR_INVALID_ACTION,
  validation_failed: ErrorCodes.ERR_INVALID_ACTION,
  validation_error: ErrorCodes.ERR_INVALID_ACTION,
  join_trix_failed: ErrorCodes.ERR_TABLE_FULL,
  join_tarneeb41_failed: ErrorCodes.ERR_TABLE_FULL,
  settlement_failed: ErrorCodes.ERR_INVALID_ACTION,
  reconnect_expired: ErrorCodes.ERR_RECONNECT_TIMEOUT,
  join_in_progress: ErrorCodes.ERR_ALREADY_PLAYING,
};

/** Normalize free-text reasons (Title Case / spaces) onto map keys. */
function normalizeReasonKey(reason) {
  if (!reason) return "";
  const raw = String(reason).trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  const underscored = lower.replace(/\s+/g, "_");
  return underscored;
}

/** Maps a legacy reason string to one of the 9 codes; falls back to ERR_INVALID_ACTION for unknown reasons. */
function codeForReason(reason) {
  if (!reason) return ErrorCodes.ERR_INVALID_ACTION;
  const raw = String(reason).trim();
  if (REASON_TO_CODE[raw]) return REASON_TO_CODE[raw];
  const key = normalizeReasonKey(raw);
  return REASON_TO_CODE[key] || ErrorCodes.ERR_INVALID_ACTION;
}

module.exports = {
  ...ErrorCodes, // spread the 9 constants so `const {ERR_NOT_SEATED} = require(...)` works
  ErrorCodes, // the frozen object so `const {ErrorCodes} = require(...)` works
  REASON_TO_CODE,
  codeForReason,
  normalizeReasonKey,
};
