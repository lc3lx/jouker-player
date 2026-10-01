#!/usr/bin/env node
"use strict";
// Compatibility entry point: the common audit completes every bonus and includes
// bank accumulation, retriggers, rounding, caps and jackpot prize liability.
const { main } = require("./slotEconomyAudit");
if (!process.argv.some(arg => arg.startsWith("--rounds="))) {
  process.argv.push(`--rounds=${Number(process.argv[3]) || 20000}`);
}
main();
