#!/usr/bin/env node
"use strict";
// Poseidon + Zeus now run calibrated economy profiles. The old audit applied a
// retired pay scale to them and misreported the money; verify the profiles.
if (!process.argv.some((a) => a.startsWith("--game="))) process.argv.push("--game=poseidon");
require("./slotProfileVerify");
