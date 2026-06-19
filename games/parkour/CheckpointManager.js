/**
 * Checkpoint validation and track geometry for Parkour races.
 */
function distance3(a, b) {
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

class CheckpointManager {
  /**
   * @param {{ checkpoints: Array, finishLine: object, spawnPoint?: object }} track
   */
  constructor(track) {
    this.checkpoints = [...(track.checkpoints || [])].sort((a, b) => a.index - b.index);
    this.finishLine = track.finishLine || { x: 0, y: 0, z: 0, radius: 4 };
    this.spawnPoint = track.spawnPoint || { x: 0, y: 0, z: 0 };
    this.totalCheckpoints = this.checkpoints.length;
  }

  getCheckpoint(index) {
    return this.checkpoints.find((c) => c.index === index) || null;
  }

  expectedNextCheckpoint(lastCheckpoint) {
    return lastCheckpoint + 1;
  }

  isWithinCheckpoint(position, checkpoint) {
    if (!checkpoint || !position) return false;
    return distance3(position, checkpoint) <= (checkpoint.radius || 3);
  }

  isWithinFinish(position) {
    return this.isWithinCheckpoint(position, this.finishLine);
  }

  validateCheckpointReach({ lastCheckpoint, checkpointIndex, position }) {
    const expected = this.expectedNextCheckpoint(lastCheckpoint);
    if (checkpointIndex !== expected) {
      return { valid: false, reason: "wrong_checkpoint_order", expected, got: checkpointIndex };
    }
    const cp = this.getCheckpoint(checkpointIndex);
    if (!cp) {
      return { valid: false, reason: "invalid_checkpoint_index" };
    }
    if (!this.isWithinCheckpoint(position, cp)) {
      return { valid: false, reason: "checkpoint_out_of_range" };
    }
    return { valid: true, checkpoint: cp, respawn: { x: cp.x, y: cp.y, z: cp.z } };
  }

  validateFinish({ lastCheckpoint, position }) {
    if (lastCheckpoint !== this.totalCheckpoints - 1) {
      return {
        valid: false,
        reason: "checkpoints_incomplete",
        required: this.totalCheckpoints - 1,
        lastCheckpoint,
      };
    }
    if (!this.isWithinFinish(position)) {
      return { valid: false, reason: "finish_out_of_range" };
    }
    return { valid: true };
  }

  getRespawnPoint(lastCheckpoint) {
    if (lastCheckpoint < 0) return { ...this.spawnPoint };
    const cp = this.getCheckpoint(lastCheckpoint);
    if (cp) return { x: cp.x, y: cp.y, z: cp.z };
    return { ...this.spawnPoint };
  }
}

module.exports = { CheckpointManager, distance3 };
