"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Table = require("../models/tableModel");
const svc = require("../services/tableInteractionsService");
const { registerTableInteractionHandlers } = require("../sockets/tableInteractions");

test("dealer target is poker-only and still requires an authorized paid send", async () => {
  const originalFind = Table.findOne;
  const originalSend = svc.sendInteraction;
  let seated = true;
  let charges = 0;
  let broadcasts = 0;
  Table.findOne = () => ({ select: () => ({ lean: async () => seated ? { seats: [{ user: "hero" }] } : null }) });
  svc.sendInteraction = async ({ targetUserId }) => {
    charges++;
    return { ok: true, event: { targetUserId } };
  };
  try {
    const handlers = {};
    const socket = { userId: "hero", rooms: new Set(["room"]), on: (name, fn) => { handlers[name] = fn; } };
    const nsp = { on: (_, fn) => fn(socket), to: () => ({ emit: (_, event) => {
      broadcasts++;
      assert.equal(event.targetUserId, "dealer");
    } }) };
    registerTableInteractionHandlers(nsp, () => "room");
    const send = async (gameType, targetUserId) => {
      let result;
      await handlers.send_interaction({ gameType, tableId: "table", itemKey: "tomato", targetUserId, actionId: "one" }, value => { result = value; });
      return result;
    };
    assert.equal((await send("poker", "dealer")).ok, true);
    assert.equal((await send("trix", "dealer")).reason, "TARGET_NOT_IN_TABLE");
    assert.equal((await send("poker", "stranger")).reason, "TARGET_NOT_IN_TABLE");
    seated = false;
    assert.equal((await send("poker", "dealer")).reason, "NOT_SEATED");
    assert.equal(charges, 1);
    assert.equal(broadcasts, 1);
  } finally {
    Table.findOne = originalFind;
    svc.sendInteraction = originalSend;
  }
});
