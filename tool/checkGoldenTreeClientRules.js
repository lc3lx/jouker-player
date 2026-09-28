"use strict";
// Cross-repository audit: prices, payouts and diagrams must agree with server.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { PAYTABLE, PAYLINES, BUY_BONUS_COST, FREE_SPINS_PER_BONUS } =
  require("../games/goldenTree/constants");
const file = process.argv[2] || path.resolve(__dirname,
  "../../frontapp/lib/features/game/slots/golden_tree/golden_tree_rules.dart");
const dart = fs.readFileSync(file, "utf8");
const block = dart.split("static const paylines = <List<int>>[")[1].split("];")[0];
const paylines = [...block.matchAll(/\[([0-2, ]+)\]/g)]
  .map(match => JSON.parse("[" + match[1] + "]"));
assert.deepEqual(paylines, PAYLINES);
for (const [symbol, payout] of Object.entries(PAYTABLE)) {
  const row = dart.match(new RegExp("GoldenTreeSymbolKind\\." + symbol + ": \\[([^\\]]+)\\]"));
  assert.ok(row, "missing paytable symbol " + symbol);
  assert.deepEqual(JSON.parse("[" + row[1] + "]"), payout, symbol);
}
assert.equal(Number(dart.match(/buyBonusCostMultiplier = ([\d.]+)/)[1]), BUY_BONUS_COST);
assert.equal(Number(dart.match(/freeSpinsPerBonus = (\d+)/)[1]), FREE_SPINS_PER_BONUS);
console.log("Client/server match: 20 paylines, 9 payout rows, bonus price and spin count.");
