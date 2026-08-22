/**
 * Agent/debug disk+HTTP logging kill-switch.
 * Enabled only when AGENT_DEBUG=1 — never in normal beta/production traffic.
 */
function isAgentDebugEnabled() {
  return String(process.env.AGENT_DEBUG || "") === "1";
}

module.exports = { isAgentDebugEnabled };
