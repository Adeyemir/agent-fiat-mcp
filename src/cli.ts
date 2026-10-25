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
  let circleVersion: unknown = "Not checked: no Arc agent wallet configured.";
  if (config.arcAddress) {
    try { circleVersion = await new CircleAgent(config.circleBin, config.arcAddress, config.arcNetwork).checkVersion(); }
    catch (error) { circleVersion = publicError(error); }
  }
  console.log(JSON.stringify({
    mode: config.mode, simulated: config.mode === "demo", node: process.version,
    dataDir: config.dataDir, circleAgentWalletConfigured: Boolean(config.arcAddress), circleVersion,
    providerEnvironment: config.pajEnvironment, arcNetwork: config.arcNetwork,
    providerApiVersion: "v2", providerLoginRequired: false, providerApiKeyInEnvironment: Boolean(config.pajApiKey), payoutExecutionImplemented: true, livePayoutsVerified: false,
    nextStep: config.mode === "demo" ? "Explicit simulation selected. Remove OFFRAMP_MODE=demo to use real tools." : "Run provider:check, choose a recipient and review a prepared payout's indicative NGN and network-fee terms before human approval. This command does not verify bank credit; live-test evidence is recorded in docs/live-integration.md.",
  }, null, 2));
}

async function main() {
  const [command, payoutId, ...extra] = process.argv.slice(2);
  if (command === "doctor") return doctor();
  if (command === "provider-check") {
    requireThat(payoutId === undefined, "INVALID_COMMAND", "provider-check takes no arguments.");
    const readiness = await inspectReadiness(loadConfig());
    console.log(JSON.stringify(readiness, null, 2));
    if (!readiness.provider.indicativeRate.ok || !readiness.provider.accountAccess.ok || !readiness.provider.arcOrdersAvailable) process.exitCode = 1;
    return;
  }
  if (command === "provider-login") {
    requireThat(payoutId === undefined, "INVALID_COMMAND", "provider-login takes no arguments. Credentials belong in your private local environment.");
    return providerLogin(loadConfig());
  }
  if (command === "fund" || command === "funding-status" || command === "funding-history") {
    requireThat(extra.length === 0 && (command === "funding-history" ? payoutId === undefined : Boolean(payoutId)), "INVALID_COMMAND", "Use fund <amount-ngn>, funding-status <funding-id>, or funding-history.");
    if (command === "funding-status") requireThat(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payoutId!), "INVALID_COMMAND", "Use the local funding ID returned by fund.");
    const runtime = createRuntime();
    try {
      requireThat(runtime.funding, "FUNDING_UNAVAILABLE", "Naira funding is available only in live mode for the existing Arc mainnet agent wallet.");
      const response = command === "fund" ? await runtime.funding.prepare({ amountNgn: payoutId! }) : command === "funding-status" ? await runtime.funding.status(payoutId!) : runtime.funding.history();
      console.log(JSON.stringify(response, null, 2));
    } finally { runtime.close(); }
    return;
  }
  if (command === "quote") {
    requireThat(payoutId && extra.length === 1 && (extra[0] === "NGN" || extra[0] === "USDC"), "INVALID_COMMAND", "Use quote <amount> <NGN|USDC>. This prepares an order but does not send funds.");
    const runtime = createRuntime();
    try { console.log(JSON.stringify(await runtime.service.prepare({ amount: payoutId, currency: extra[0] }), null, 2)); }
    finally { runtime.close(); }
    return;
  }
  if (command === "--help" || command === "help") {
    console.log("agent-fiat-mcp [serve | doctor | provider-check | set-bank | quote <amount> <NGN|USDC> | approve <payout-id> | fund <amount-ngn> | funding-status <funding-id> | funding-history]\nLocal Circle Agent Wallet + PAJ v2 integration. Offramp payments require human approval. Funding returns bank instructions for a manual naira payment; it never debits a bank account. Amounts and network fees are estimates. OFFRAMP_MODE=demo explicitly selects payout simulation.");
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
        const bank = await reader.question(runtime.config.mode === "demo" ? "Bank (demo: Demo Bank): " : "Nigerian bank name or code: ");
        const accountNumber = await reader.question("Ten-digit account number: ");
        const expectedName = await reader.question("Full account holder name: ");
        console.log(JSON.stringify(await runtime.service.setDefaultBank({ bank, accountNumber, expectedName }, account => confirm(`Save ${account.name}, ${account.bank}, ${account.accountNumber}? ${account.simulated ? "DEMO: no real verification." : `Verified with PAJ ${runtime.config.pajEnvironment}; stored locally for Arc ${runtime.config.arcNetwork}.`}`)), null, 2));
      } else {
        console.log(JSON.stringify(await runtime.service.execute(payoutId!, (payout, bank) => confirm(payoutApprovalMessage(payout, bank))), null, 2));
      }
    } finally { reader.close(); runtime.close(); }
    return;
  }
  const runtime = createRuntime();
  const server = createMcpServer(runtime.service, { readiness: () => inspectReadiness(runtime.config), ...(runtime.funding ? { funding: runtime.funding } : {}) });
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
