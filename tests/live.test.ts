import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { LiveService } from "../src/live-service.js";
import { createMcpServer } from "../src/mcp.js";
import { createRuntime } from "../src/runtime.js";
import { Store } from "../src/store.js";
import type { JsonRequest } from "../src/providers/paj.js";

const bank = { bank: "999", accountNumber: "0123456789", expectedName: "TEST USER" };
const directory = [{ id: "bank_1", code: "999", name: "Example Bank", country: "NG" }];
const toolNames = ["execute_payout", "get_balance", "get_default_bank", "get_readiness", "list_banks", "payout_history", "payout_status", "prepare_payout", "set_default_bank"];
const data = (response: Record<string, unknown>) => response.structuredContent as { result?: Record<string, unknown> | null; error?: { code: string } };

async function setup(t: test.TestContext, options: { forms?: boolean; approve?: boolean; holderName?: string } = {}) {
  const store = new Store(":memory:");
  const config = loadConfig({ PAJ_API_KEY: "fake-api-key" });
  const calls: { url: string; options: RequestInit }[] = [];
  const request: JsonRequest = async (url, init = {}) => {
    calls.push({ url, options: init });
    assert.equal(new Headers(init.headers).get("x-api-key"), "fake-api-key");
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    if (url.includes("/bank?")) { assert.equal(init.method, "GET"); return directory; }
    assert.equal(new URL(url).pathname, "/pub/v2/bank-account");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { accountNumber: bank.accountNumber, bankCode: "999" });
    return { id: "registered_1", accountNumber: bank.accountNumber, accountName: options.holderName ?? "USER TEST", bank: "Example Bank", address: "SolanaStandingAddressNeverUsedForArc" };
  };
  const service = new LiveService(config, store, request);
  const server = createMcpServer(service, { readiness: async () => ({ livePayoutsAvailable: false }) });
  const forms = options.forms !== false;
  const client = new Client({ name: "live-test-client", version: "1" }, { capabilities: forms ? { elicitation: { form: {} } } : {} });
  const prompts: string[] = [];
  if (forms) client.setRequestHandler(ElicitRequestSchema, async request => {
    prompts.push(request.params.message);
    return options.approve === false ? { action: "decline" } : { action: "accept", content: { approve: true } };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); store.close(); });
  return { client, calls, prompts, store, service, config, request };
}

test("default runtime exposes the real payout implementation and creates no simulated funds", t => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-live-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = createRuntime(loadConfig({ OFFRAMP_DATA_DIR: dir, PAJ_GATEWAY_SETTLEMENT_VERIFIED: "true", PAJ_SESSION_TOKEN: "dummy" }));
  try {
    assert.equal(runtime.config.mode, "live");
    assert.equal(runtime.config.arcNetwork, "mainnet");
    assert.equal(runtime.config.pajEnvironment, "production");
    assert.ok(runtime.service instanceof LiveService);
    assert.equal("execute" in runtime.service, true);
    assert.equal("prepare" in runtime.service, true);
    assert.equal(existsSync(join(dir, "offramp.sqlite")), false);
    const db = new DatabaseSync(join(dir, "offramp-live-production-mainnet.sqlite"));
    try {
      assert.equal(db.prepare("SELECT value FROM settings WHERE key='demo_balance'").get(), undefined);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='demo_transfers'").get(), undefined);
    } finally { db.close(); }
  } finally { runtime.close(); }
});

test("live MCP exposes real account tools and never substitutes demo data when setup is missing", async t => {
  const { client, calls, store } = await setup(t);
  store.setBank("demo", { bankId: "demo", bankName: "Demo Bank", accountNumber: "0000000000", accountName: "DEMO USER" });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), toolNames);
  assert.equal(data(await client.callTool({ name: "get_default_bank", arguments: {} })).result, null);
  const balance = data(await client.callTool({ name: "get_balance", arguments: {} }));
  assert.equal(balance.error?.code, "WALLET_SETUP_REQUIRED");
  assert.equal(balance.result, undefined);
  assert.equal(calls.length, 0);
});

test("PAJ resolves a bank before human approval, and only the verified recipient is saved locally", async t => {
  const { client, calls, prompts, store, service, config, request } = await setup(t);
  assert.deepEqual(data(await client.callTool({ name: "list_banks", arguments: {} })).result?.banks, directory);
  const response = await client.callTool({ name: "set_default_bank", arguments: bank });
  assert.equal(response.isError, undefined);
  assert.equal(data(response).result?.simulated, false);
  assert.equal(data(response).result?.accountEnding, "6789");
  assert.equal(JSON.stringify(response).includes(bank.accountNumber), false);
  assert.equal(JSON.stringify(response).includes("fake-api-key"), false);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.includes(bank.accountNumber));
  assert.ok(prompts[0]!.includes("USER TEST"));
  assert.ok(prompts[0]!.includes("PAJ environment: production"));
  assert.ok(prompts[0]!.includes("Arc source network: mainnet"));
  assert.ok(calls.some(call => call.url.includes("/pub/v2/bank-account")));
  assert.equal(calls.filter(call => call.options.method === "POST").length, 1);
  assert.equal(calls.some(call => call.url.includes("offramp")), false);
  const saved = data(await client.callTool({ name: "get_default_bank", arguments: {} })).result;
  assert.equal(saved?.bank, "Example Bank");
  assert.equal(saved?.accountEnding, "6789");
  assert.deepEqual(new LiveService(config, store, request).defaultBank(), service.defaultBank());
  assert.equal(new LiveService({ ...config, pajEnvironment: "staging" }, store, request).defaultBank(), null);
  assert.equal(new LiveService({ ...config, arcNetwork: "testnet" }, store, request).defaultBank(), null);
  assert.equal(store.getBank("demo"), undefined);
});

test("declined approval or a mismatched holder name cannot save a real recipient", async t => {
  for (const options of [{ approve: false }, { holderName: "OTHER USER" }]) {
    const { client, service } = await setup(t, options);
    const response = data(await client.callTool({ name: "set_default_bank", arguments: bank }));
    assert.equal(response.error?.code, "approve" in options ? "APPROVAL_REQUIRED" : "NAME_MISMATCH");
    assert.equal(service.defaultBank(), null);
  }
});

test("missing human forms or an approval flag cannot trigger real bank verification", async t => {
  const { client, calls } = await setup(t, { forms: false });
  assert.equal(data(await client.callTool({ name: "set_default_bank", arguments: bank })).error?.code, "HUMAN_APPROVAL_UNAVAILABLE");
  assert.equal((await client.callTool({ name: "set_default_bank", arguments: { ...bank, confirmed: true } })).isError, true);
  assert.equal(calls.length, 0);
});

test("the default stdio server exposes real tools and requires wallet setup instead of simulation", async t => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-live-stdio-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^(OFFRAMP_|PAJ_|CIRCLE_|ARC_)/.test(entry[0])));
  const client = new Client({ name: "default-stdio-test", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/cli.ts"], env: { ...env, OFFRAMP_DATA_DIR: dir }, stderr: "pipe" }));
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), toolNames);
    assert.equal(data(await client.callTool({ name: "get_balance", arguments: {} })).error?.code, "WALLET_SETUP_REQUIRED");
  } finally { await client.close(); }
});
