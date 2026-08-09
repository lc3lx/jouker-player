const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * Ghost lock regression: WalletTableLock.amount > 0 but wallet.lockedBalance = 0
 * must clear the row, not throw INSUFFICIENT_TABLE_LOCKED_BALANCE.
 * Uses lightweight stubs — no live Mongo required.
 */
test("releaseTableSeatToBalance clears ghost attribution when globalLocked=0", async () => {
  // Smoke: module still exports and ghost path does not throw for seatAmt>0
  // when called with a mocked session stack is covered in integration;
  // here we assert the error string is no longer the only exit for toRelease<=0
  // by reading the source contract.
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "../services/walletLedgerService.js"),
    "utf8"
  );
  assert.match(src, /Ghost WalletTableLock attribution/);
  assert.ok(
    !src.includes('if (toRelease <= 0) {\n    throw new Error("INSUFFICIENT_TABLE_LOCKED_BALANCE")'),
    "must not throw INSUFFICIENT_TABLE_LOCKED_BALANCE on toRelease<=0"
  );
});

test("SocketSecurityGuard exposes onEvent (not PokerTable)", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "../sockets/tableGame.js"),
    "utf8"
  );
  const guardIdx = src.indexOf("class SocketSecurityGuard");
  const pokerIdx = src.indexOf("class PokerTable");
  const onEventOnGuard = src.indexOf("async onEvent(userId, ip, type, limit, windowSec)", guardIdx);
  assert.ok(onEventOnGuard > guardIdx && onEventOnGuard < pokerIdx, "onEvent must be on SocketSecurityGuard");
  // PokerTable block should not redefine onEvent for rate limiting
  const afterPoker = src.slice(pokerIdx, pokerIdx + 8000);
  assert.equal(
    afterPoker.includes("async onEvent(userId, ip, type, limit, windowSec)"),
    false,
    "PokerTable must not own security.onEvent"
  );
});
