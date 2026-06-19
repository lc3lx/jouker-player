const { distance3 } = require("./CheckpointManager");

const DEFAULT_MAX_SPEED = parseFloat(process.env.PARKOUR_MAX_SPEED || "25");
const MIN_POSITION_INTERVAL_MS = parseInt(process.env.PARKOUR_MIN_POSITION_INTERVAL_MS || "50", 10);

class AntiCheatValidator {
  constructor(options = {}) {
    this.maxSpeed = options.maxSpeed || DEFAULT_MAX_SPEED;
    this.minIntervalMs = options.minIntervalMs || MIN_POSITION_INTERVAL_MS;
    this.usedNonces = new Set();
  }

  resetNonces(nonces = []) {
    this.usedNonces = new Set(nonces || []);
  }

  consumeNonce(nonce) {
    const n = String(nonce || "").trim();
    if (n.length < 8) return { valid: false, reason: "invalid_nonce" };
    if (this.usedNonces.has(n)) return { valid: false, reason: "replay_nonce" };
    this.usedNonces.add(n);
    return { valid: true };
  }

  /**
   * Validate movement between two server-recorded positions.
   * @param {{ x,y,z,t }} from
   * @param {{ x,y,z,t }} to
   */
  validateMovement(from, to) {
    if (!from || !to) return { valid: true, speed: 0 };

    const dtMs = Math.max(1, (to.t || 0) - (from.t || 0));
    if (dtMs < this.minIntervalMs) {
      return { valid: false, reason: "position_spam", dtMs };
    }

    const dist = distance3(from, to);
    const speed = dist / (dtMs / 1000);

    if (speed > this.maxSpeed) {
      return { valid: false, reason: "impossible_speed", speed, maxSpeed: this.maxSpeed, dist, dtMs };
    }

    return { valid: true, speed, dist, dtMs };
  }

  validateTeleportAttempt(from, to, threshold = 50) {
    const dist = distance3(from, to);
    if (dist > threshold) {
      return { valid: false, reason: "teleport_detected", dist, threshold };
    }
    return { valid: true };
  }
}

module.exports = AntiCheatValidator;
