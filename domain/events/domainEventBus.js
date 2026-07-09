"use strict";

const { EventEmitter } = require("events");
const logger = require("../../utils/logger");

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const handlers = new Map();

function subscribe(eventType, handler, { name } = {}) {
  if (typeof handler !== "function") return;
  const key = name || handler.name || "anonymous";
  if (!handlers.has(eventType)) handlers.set(eventType, []);
  handlers.get(eventType).push({ key, handler });
}

function publish(eventType, payload = {}) {
  const list = handlers.get(eventType) || [];
  if (!list.length) return;

  setImmediate(() => {
    for (const { key, handler } of list) {
      Promise.resolve()
        .then(() => handler({ eventType, payload, at: Date.now() }))
        .catch((err) => {
          logger.warn("domain_event_handler_failed", {
            eventType,
            handler: key,
            reason: err?.message || String(err),
          });
        });
    }
  });
}

function clearAll() {
  handlers.clear();
}

module.exports = {
  subscribe,
  publish,
  clearAll,
};
