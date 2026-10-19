#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { CircleAgent } from "./adapters/circle.js";
import { publicError, requireThat } from "./errors.js";
import { createMcpServer, payoutApprovalMessage } from "./mcp.js";
import { createRuntime } from "./runtime.js";
import { inspectReadiness } from "./readiness.js";
import { providerLogin } from "./provider-login.js";

async function doctor() {
  const config = loadConfig();
  let circleVersion: unknown = "Not checked: demo needs no wallet.";
  if (config.arcAddress) {
    try { circleVersion = await new CircleAgent(config.circleBin, config.arcAddress, config.arcNetwork).checkVersion(); }
    catch (error) { circleVersion = publicError(error); }
  }
  console.log(JSON.stringify({
    mode: config.mode, simulated: config.mode === "demo", node: process.version,
    dataDir: config.dataDir, circleAgentWalletConfigured: Boolean(config.arcAddress), circleVersion,
    providerEnvironment: config.pajEnvironment, arcNetwork: config.arcNetwork,
    providerSessionTokenInEnvironment: Boolean(config.pajToken), providerApiKeyInEnvironment: Boolean(config.pajApiKey), livePayoutsAvailable: false,
    nextStep: config.mode === "demo" ? "Run npm run demo, or connect this stdio MCP server to your client." : "Live settlement is not implemented or verified. Use demo mode for now.",
  }, null, 2));
  if (config.mode === "live") process.exitCode = 1;
}

async function main() {
  const [command, payoutId, ...extra] = process.argv.slice(2);
  if (command === "doctor") return doctor();
  if (command === "provider-check") {
    requireThat(payoutId === undefined, "INVALID_COMMAND", "provider-check takes no arguments.");
    const readiness = await inspectReadiness(loadConfig());
    console.log(JSON.stringify(readiness, null, 2));
    if (!readiness.provider.indicativeRate.ok || !readiness.gateway.ok) process.exitCode = 1;
    return;
  }
  if (command === "provider-login") {
    requireThat(payoutId === undefined, "INVALID_COMMAND", "provider-login takes no arguments. Credentials belong in your private local environment.");
    return providerLogin(loadConfig());
  }
  if (command === "--help" || command === "help") {
    console.log("naira-offramp-mcp [serve | doctor | provider-check | provider-login | set-bank | approve <payout-id>]\nDefault: serve MCP over stdio. This release supports demo payouts and read-only integration checks.");
    return;
  }
  requireThat(!command || ["serve", "set-bank", "approve"].includes(command), "INVALID_COMMAND", "Use serve, doctor, set-bank or approve <payout-id>.");
  requireThat(extra.length === 0 && (command === "approve" ? Boolean(payoutId) : payoutId === undefined), "INVALID_COMMAND", "Only approve takes an argument: the prepared payout ID.");
  if (command === "set-bank" || command === "approve") {
    requireThat(process.stdin.isTTY && process.stdout.isTTY, "INTERACTIVE_TERMINAL_REQUIRED", "Human review requires an interactive terminal. Piped input is not accepted.");
    const runtime = createRuntime();
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    const confirm = async (message: string) => (await reader.question(`${message}\nType APPROVE to continue: `)) === "APPROVE";
    try {
      if (command === "set-bank") {
        const bank = await reader.question("Bank (demo: Demo Bank): ");
        const accountNumber = await reader.question("Account number (demo: 0000000000): ");
        const expectedName = await reader.question("Full account holder name (demo: DEMO USER): ");
        console.log(JSON.stringify(await runtime.service.setDefaultBank({ bank, accountNumber, expectedName }, account => confirm(`Save ${account.name}, ${account.bank}, ${account.accountNumber}? DEMO: no real bank verification.`)), null, 2));
      } else {
        console.log(JSON.stringify(await runtime.service.execute(payoutId!, (payout, bank) => confirm(payoutApprovalMessage(payout, bank))), null, 2));
      }
    } finally { reader.close(); runtime.close(); }
    return;
  }
  const runtime = createRuntime();
  const server = createMcpServer(runtime.service, { readiness: () => inspectReadiness(runtime.config) });
  let closed = false;
  const shutdown = () => { if (!closed) { closed = true; runtime.close(); } };
  server.server.onclose = shutdown;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void server.close().finally(shutdown); });
  }
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { shutdown(); throw error; }
  // Protocol messages own stdout. Diagnostics and failures use stderr only.
}

main().catch(error => { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; });
