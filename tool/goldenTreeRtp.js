#!/usr/bin/env node
"use strict";
// Same settlement-aware audit as the other slots, restricted to Golden Tree.
const { main } = require("./slotEconomyAudit");
process.argv.push("--game=golden-tree");
if (!process.argv.some(arg => arg.startsWith("--rounds="))) {
  process.argv.push(`--rounds=${Number(process.argv[3]) || 20000}`);
}
main();
