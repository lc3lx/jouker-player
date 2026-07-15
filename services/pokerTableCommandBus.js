"use strict";

/**
 * H-3 command bus — routes MUTATING table operations from a follower instance to
 * the single authoritative owner instance over Redis pub/sub.
 *
 * Each instance subscribes to its own inbox channel `poker:cmd:<instanceId>`.
 * A follower that receives a socket action for a table it does not own looks up
 * the current owner (`ownership.currentOwner`) and publishes the command to that
 * owner's inbox. The owner applies it to its authoritative in-memory engine and
 * emits any socket-targeted result cluster-wide via the socket.io redis-adapter.
 *
 * Idempotency/serialization for the actual game mutation is unchanged: the owner
 * still runs everything under the per-table Redis action lock + actionId guard,
 * so a duplicated/redelivered command can never double-apply.
 */

const logger = require("../utils/logger");

function inboxChannel(instanceId) {
  return `poker:cmd:${instanceId}`;
}

class PokerTableCommandBus {
  /**
   * @param {object|null} redis node-redis command client (or null → disabled)
   * @param {{ instanceId: string, onCommand: (cmd: object) => Promise<void> }} opts
   */
  constructor(redis, { instanceId, onCommand } = {}) {
    this.redis = redis || null;
    this.instanceId = instanceId;
    this.onCommand = onCommand;
    this.sub = null;
    this.started = false;
  }

  isEnabled() {
    return !!this.redis;
  }

  async start() {
    if (!this.redis || this.started) return;
    this.started = true;
    // A subscriber connection cannot issue normal commands, so duplicate.
    this.sub = this.redis.duplicate();
    this.sub.on("error", () => {
      /* transient — the adapter/alerts surface Redis health separately */
    });
    await this.sub.connect();
    await this.sub.subscribe(inboxChannel(this.instanceId), (message) => {
      let cmd = null;
      try {
        cmd = JSON.parse(message);
      } catch (_) {
        return;
      }
      Promise.resolve(this.onCommand(cmd)).catch((e) => {
        logger.warn("poker_command_dispatch_failed", {
          type: cmd?.type,
          tableId: cmd?.tableId,
          reason: e?.message || "unknown",
        });
      });
    });
  }

  /** Publish a command to the owner instance's inbox. */
  async publishTo(ownerInstanceId, command) {
    if (!this.redis || !ownerInstanceId) return false;
    try {
      await this.redis.publish(
        inboxChannel(ownerInstanceId),
        JSON.stringify({ ...command, from: this.instanceId, ts: Date.now() })
      );
      return true;
    } catch (e) {
      logger.warn("poker_command_publish_failed", {
        type: command?.type,
        tableId: command?.tableId,
        ownerInstanceId,
        reason: e?.message || "unknown",
      });
      return false;
    }
  }

  async stop() {
    this.started = false;
    if (this.sub) {
      try {
        await this.sub.unsubscribe(inboxChannel(this.instanceId));
        await this.sub.quit();
      } catch (_) {
        /* closing anyway */
      }
      this.sub = null;
    }
  }
}

module.exports = { PokerTableCommandBus, inboxChannel };
