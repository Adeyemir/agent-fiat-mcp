import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DemoProvider, DemoSettlement } from "../src/adapters/demo.js";
import { createMcpServer } from "../src/mcp.js";
import { PayoutService } from "../src/service.js";
import { Store } from "../src/store.js";

const bank = { bank: "Demo Bank", accountNumber: "0000000000", expectedName: "DEMO USER" };
function data(response: Record<string, unknown>) {
  return response.structuredContent as { result?: Record<string, unknown>; error?: { code: string } };
}

async function setup(t: test.TestContext, supportsForms = true, allow = true, readiness?: () => Promise<unknown>) {
  const store = new Store(":memory:");
  const service = new PayoutService("demo", new DemoProvider(store), new DemoSettlement(store), store);
  const server = createMcpServer(service, readiness ? { readiness } : {});
  const client = new Client({ name: "test-human-client", version: "1" }, { capabilities: supportsForms ? { elicitation: { form: {} } } : {} });
  const prompts: string[] = [];
  if (supportsForms) client.setRequestHandler(ElicitRequestSchema, async request => {
    prompts.push(request.params.message);
    return allow ? { action: "accept", content: { approve: true } } : { action: "decline" };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); store.close(); });
  return { client, prompts, store };
}

test("MCP discovers seven tools and completes the quote/approval/status flow", async t => {
  const { client, prompts } = await setup(t);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["execute_payout", "get_balance", "get_default_bank", "payout_history", "payout_status", "prepare_payout", "set_default_bank"]);
  assert.equal((await client.callTool({ name: "set_default_bank", arguments: bank })).isError, undefined);
  const quoteResponse = await client.callTool({ name: "prepare_payout", arguments: { amount: "15000", currency: "NGN" } });
  const quote = data(quoteResponse).result!;
  assert.equal(quote.state, "prepared");
  const executed = data(await client.callTool({ name: "execute_payout", arguments: { payoutId: quote.payoutId } })).result!;
  assert.equal(executed.state, "completed");
  assert.equal(executed.simulated, true);
  assert.equal(executed.bankPaid, false);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1]!.includes("Maximum total debit: 10.15 USDC on Arc"));
  assert.ok(prompts[1]!.includes("account 0000000000"));
  assert.ok(prompts[1]!.includes(String(quote.payoutId)));
  const history = JSON.stringify(await client.callTool({ name: "payout_history", arguments: {} }));
  assert.equal(history.includes(bank.accountNumber), false);
  assert.equal(history.includes("depositAddress"), false);
  await client.callTool({ name: "execute_payout", arguments: { payoutId: quote.payoutId } });
  assert.equal(prompts.length, 2);
  const balance = data(await client.callTool({ name: "get_balance", arguments: {} })).result!;
  assert.equal(balance.spendableUsdc, "89.85");
});

test("a declined elicitation does not set a bank or execute a payout", async t => {
  const { client } = await setup(t, true, false);
  assert.equal(data(await client.callTool({ name: "set_default_bank", arguments: bank })).error?.code, "APPROVAL_REQUIRED");
  const quote = data(await client.callTool({ name: "prepare_payout", arguments: { amount: "1000", currency: "NGN", bank } })).result!;
  assert.equal(data(await client.callTool({ name: "execute_payout", arguments: { payoutId: quote.payoutId } })).error?.code, "APPROVAL_REQUIRED");
  const balance = data(await client.callTool({ name: "get_balance", arguments: {} })).result!;
  assert.equal(balance.spendableUsdc, "100");
});

test("a client without human forms cannot approve via tool arguments", async t => {
  const { client, store } = await setup(t, false);
  assert.equal(data(await client.callTool({ name: "set_default_bank", arguments: bank })).error?.code, "HUMAN_APPROVAL_UNAVAILABLE");
  const quote = data(await client.callTool({ name: "prepare_payout", arguments: { amount: "1000", currency: "NGN", bank } })).result!;
  const injected = await client.callTool({ name: "execute_payout", arguments: { payoutId: quote.payoutId, confirmed: true } });
  assert.equal(injected.isError, true);
  assert.equal(store.get(String(quote.payoutId)).state, "prepared");
  assert.equal(data(await client.callTool({ name: "execute_payout", arguments: { payoutId: quote.payoutId } })).error?.code, "HUMAN_APPROVAL_UNAVAILABLE");
});

test("integration readiness is available through MCP without payment approval or secret arguments", async t => {
  let checks = 0;
  const { client, prompts } = await setup(t, false, false, async () => { checks++; return { livePayoutsAvailable: false, provider: { sessionConfigured: false } }; });
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 8);
  const inspected = data(await client.callTool({ name: "get_readiness", arguments: {} })).result!;
  assert.equal(inspected.livePayoutsAvailable, false);
  assert.equal(prompts.length, 0);
  assert.equal(checks, 1);
  assert.equal((await client.callTool({ name: "get_readiness", arguments: { apiKey: "do-not-send-secrets" } })).isError, true);
  assert.equal(checks, 1);
});

test("the real stdio CLI exposes MCP and persists a payout across process restarts", async t => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-stdio-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const connect = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", "src/cli.ts"],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), OFFRAMP_MODE: "demo", OFFRAMP_DATA_DIR: dir }, stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
    await client.connect(transport);
    return client;
  };
  const first = await connect();
  let payoutId: unknown;
  try {
    assert.ok((await first.listTools()).tools.some(tool => tool.name === "get_readiness"));
    await first.callTool({ name: "set_default_bank", arguments: bank });
    const quote = data(await first.callTool({ name: "prepare_payout", arguments: { amount: "15000", currency: "NGN" } })).result!;
    payoutId = quote.payoutId;
    assert.equal(data(await first.callTool({ name: "execute_payout", arguments: { payoutId } })).result?.state, "completed");
  } finally { await first.close(); }
  const second = await connect();
  try {
    assert.equal(data(await second.callTool({ name: "payout_status", arguments: { payoutId } })).result?.state, "completed");
    assert.equal(data(await second.callTool({ name: "get_balance", arguments: {} })).result?.spendableUsdc, "89.85");
    assert.equal(data(await second.callTool({ name: "get_default_bank", arguments: {} })).result?.accountEnding, "0000");
  } finally { await second.close(); }
});
