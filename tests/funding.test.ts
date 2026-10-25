import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { OfframpError } from "../src/errors.js";
import { FundingService, type FundingWallet } from "../src/funding-service.js";
import { LiveService } from "../src/live-service.js";
import { createMcpServer } from "../src/mcp.js";
import { PAJ_USDC, type JsonRequest } from "../src/providers/paj.js";
import { Store } from "../src/store.js";

const address = "0x1111111111111111111111111111111111111111";
const otherAddress = "0x2222222222222222222222222222222222222222";
const code = (expected: string) => (error: unknown) => error instanceof OfframpError && error.code === expected;

function fixture(t: test.TestContext, path = ":memory:") {
  const store = new Store(path);
  t.after(() => store.close());
  const config = loadConfig({ PAJ_API_KEY: "fake-test-key", CIRCLE_ARC_ADDRESS: address });
  const control = { now: Date.now(), active: true, authenticated: true, posts: 0, reads: 0, walletChecks: 0, failCreation: false, failStatus: false, status: "INIT", patch: {} as Record<string, unknown>, age: 0, pauseCreation: undefined as Promise<void> | undefined };
  const orders = new Map<string, Record<string, unknown>>();
  const wallet: FundingWallet = { address, chain: "ARC", checkVersion: async () => "1.2.2", requireAgentWallet: async () => { control.walletChecks++; if (!control.authenticated) throw new OfframpError("AGENT_WALLET_REQUIRED", "Not the authenticated wallet."); } };
  const request: JsonRequest = async (url, options = {}) => {
    assert.equal(new Headers(options.headers).get("x-api-key"), "fake-test-key");
    if (url.endsWith("/chains")) return [{ chain: "ARC", name: "Arc", isActive: control.active }];
    if (url.endsWith("/onramp")) {
      control.posts++;
      assert.equal(options.method, "POST");
      const body = JSON.parse(String(options.body));
      assert.deepEqual(body, { fiatAmount: body.fiatAmount, currency: "NGN", chain: "ARC", mint: PAJ_USDC.ARC, recipient: address });
      assert.equal(store.activeFunding(`production:mainnet:${address}`)?.state, "creating");
      if (control.pauseCreation) await control.pauseCreation;
      if (control.failCreation) throw new Error("must-not-leak-private-response");
      const id = `fund_${control.posts}`;
      const raw = { id, mint: PAJ_USDC.ARC, currency: "NGN", chain: "ARC", amount: "3.25", fiatAmount: body.fiatAmount, transactionType: "ON_RAMP", status: "INIT", recipient: address, accountNumber: "1234567890", accountName: "PAJ INC (PAY EXACT AMOUNT)", bank: "Example Bank", createdAt: new Date(control.now - control.age).toISOString(), ...control.patch };
      orders.set(id, raw);
      return raw;
    }
    assert.equal(options.method, "GET");
    assert.match(url, /\/transaction\/fund_\d+$/);
    control.reads++;
    if (control.failStatus) throw new Error("must-not-leak-private-status");
    const raw = orders.get(url.split("/").at(-1)!);
    assert.ok(raw);
    return { ...raw, status: control.status, ...control.patch };
  };
  const service = new FundingService(config, store, request, wallet, () => control.now);
  return { store, config, control, wallet, request, service, orders };
}

test("funding returns exact naira instructions for the owned wallet without any outgoing transfer", async t => {
  const f = fixture(t);
  const order = await f.service.prepare({ amountNgn: "5000.01" });
  assert.equal(order.state, "awaiting_fiat");
  assert.equal(order.amountNgn, "5000.01");
  assert.equal(order.estimatedReceiveUsdc, "3.25");
  assert.deepEqual(order.bankPayment, { bank: "Example Bank", accountName: "PAJ INC (PAY EXACT AMOUNT)", accountNumber: "1234567890", amountNgn: "5000.01", currency: "NGN" });
  assert.equal(order.recipient.walletAddress, address);
  assert.equal(order.manualBankTransferRequired, true);
  assert.equal(order.walletCreditIndependentlyVerified, false);
  assert.equal(order.receiveAmountGuaranteed, false);
  assert.equal(Date.parse(order.expiresAt!) - f.control.now, 72 * 60 * 60_000);
  assert.equal(f.control.posts, 1);
  assert.equal(f.control.walletChecks, 1);
  assert.equal(JSON.stringify(order).includes("fake-test-key"), false);
});

test("repeated funding preparation refreshes and reuses the existing pending order", async t => {
  const f = fixture(t);
  const first = await f.service.prepare({ amountNgn: "5000" });
  const repeated = await f.service.prepare({ amountNgn: "5000.00" });
  assert.equal(repeated.fundingId, first.fundingId);
  assert.equal(f.control.posts, 1);
  assert.equal(f.control.reads, 1);
  await assert.rejects(f.service.prepare({ amountNgn: "6000" }), code("FUNDING_ORDER_ACTIVE"));
  assert.equal(f.control.posts, 1);
});

test("funding tracks processing and provider delivery without inventing wallet-credit verification", async t => {
  const f = fixture(t);
  const first = await f.service.prepare({ amountNgn: "5000" });
  f.control.status = "PROCESSING";
  const processing = await f.service.status(first.fundingId);
  assert.equal(processing.state, "processing");
  assert.equal(processing.bankPayment, undefined);
  f.control.status = "COMPLETED";
  f.control.patch = { amount: "3.2", signature: `0x${"a".repeat(64)}` };
  const completed = await f.service.status(first.fundingId);
  assert.equal(completed.state, "provider_completed");
  assert.equal(completed.finalProviderUsdc, "3.2");
  assert.equal(completed.transactionHash, f.control.patch.signature);
  assert.equal(completed.walletCreditIndependentlyVerified, false);
  assert.equal(completed.bankPayment, undefined);
  await f.service.status(first.fundingId);
  assert.equal(f.control.posts, 1);
});

test("funding history masks payment accounts and does not change saved payout recipients", async t => {
  const f = fixture(t);
  f.store.setBank("saved-scope", { bankId: "old", bankName: "Saved Bank", accountNumber: "0000000000", accountName: "SAVED USER" });
  await f.service.prepare({ amountNgn: "5000" });
  const history = f.service.history();
  assert.equal(history[0]?.accountEnding, "7890");
  assert.equal(JSON.stringify(history).includes("1234567890"), false);
  assert.equal(f.store.getBank("saved-scope")?.accountName, "SAVED USER");
});

test("funding refuses wrong wallet ownership, inactive Arc and unsupported environments before creating orders", async t => {
  const f = fixture(t);
  f.control.authenticated = false;
  await assert.rejects(f.service.prepare({ amountNgn: "5000" }), code("AGENT_WALLET_REQUIRED"));
  f.control.authenticated = true;
  f.control.active = false;
  await assert.rejects(f.service.prepare({ amountNgn: "5000" }), code("PROVIDER_CHAIN_INACTIVE"));
  for (const change of [{ arcNetwork: "testnet" as const }, { mode: "demo" as const }, { pajEnvironment: "staging" as const }]) {
    const service = new FundingService({ ...f.config, ...change }, f.store, f.request, f.wallet);
    await assert.rejects(service.prepare({ amountNgn: "5000" }), code("LIVE_NETWORK_UNVERIFIED"));
  }
  await assert.rejects(new FundingService(loadConfig({}), f.store, f.request).prepare({ amountNgn: "5000" }), code("WALLET_SETUP_REQUIRED"));
  assert.equal(f.control.posts, 0);
});

test("invalid and unsafe naira amounts cannot reach provider order creation", async t => {
  const f = fixture(t);
  for (const amountNgn of ["0", "-1", "1.001", "1e3", "9007199254740992", "90071992547409.91"]) await assert.rejects(f.service.prepare({ amountNgn }), code("INVALID_AMOUNT"));
  assert.equal(f.control.posts, 0);
  assert.equal(f.control.walletChecks, 0);
});

test("uncertain funding creation is durable and never automatically retried", async t => {
  const f = fixture(t);
  f.control.failCreation = true;
  await assert.rejects(f.service.prepare({ amountNgn: "5000" }), error => {
    assert.ok(code("FUNDING_CREATION_UNCERTAIN")(error));
    assert.equal(String(error).includes("must-not-leak-private-response"), false);
    return true;
  });
  const history = f.service.history();
  assert.equal(history[0]?.state, "creation_uncertain");
  const result = await f.service.prepare({ amountNgn: "5000" });
  assert.equal(result.fundingId, history[0]?.fundingId);
  assert.equal(result.state, "creation_uncertain");
  assert.equal(result.bankPayment, undefined);
  assert.equal(f.control.posts, 1);
});

test("concurrent preparation through separate stores creates exactly one provider order", async t => {
  const directory = mkdtempSync(join(tmpdir(), "agent-fiat-concurrent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(t, join(directory, "profile.sqlite"));
  const secondStore = new Store(join(directory, "profile.sqlite"));
  t.after(() => secondStore.close());
  let release!: () => void;
  f.control.pauseCreation = new Promise<void>(resolve => { release = resolve; });
  const firstPromise = f.service.prepare({ amountNgn: "5000" });
  await new Promise<void>(resolve => setImmediate(resolve));
  const second = new FundingService(f.config, secondStore, f.request, f.wallet, () => f.control.now);
  const other = await second.prepare({ amountNgn: "5000" });
  assert.equal(other.state, "creating");
  release();
  const first = await firstPromise;
  assert.equal(first.fundingId, other.fundingId);
  assert.equal(f.control.posts, 1);
});

test("a late INIT response cannot restore bank instructions after another process observes processing", async t => {
  const directory = mkdtempSync(join(tmpdir(), "agent-fiat-status-race-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(t, join(directory, "profile.sqlite"));
  const prepared = await f.service.prepare({ amountNgn: "5000" });
  const secondStore = new Store(join(directory, "profile.sqlite"));
  t.after(() => secondStore.close());
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const delayed: JsonRequest = async (url, options) => {
    const response = await f.request(url, options);
    started();
    await held;
    return response;
  };
  const staleService = new FundingService(f.config, secondStore, delayed, f.wallet, () => f.control.now);
  const pending = staleService.status(prepared.fundingId);
  await waiting;
  f.control.status = "PROCESSING";
  assert.equal((await f.service.status(prepared.fundingId)).state, "processing");
  release();
  const result = await pending;
  assert.equal(result.state, "processing");
  assert.equal(result.providerStatus, "PROCESSING");
  assert.equal(result.bankPayment, undefined);
  assert.equal(f.store.funding(prepared.fundingId).state, "processing");
  assert.equal(f.control.posts, 1);
});

test("processing remains durable when a later provider read regresses to INIT", async t => {
  const f = fixture(t);
  const prepared = await f.service.prepare({ amountNgn: "5000" });
  f.control.status = "PROCESSING";
  await f.service.status(prepared.fundingId);
  f.control.status = "INIT";
  const restarted = new FundingService(f.config, f.store, f.request, f.wallet, () => f.control.now);
  const result = await restarted.prepare({ amountNgn: "5000" });
  assert.equal(result.state, "processing");
  assert.equal(result.providerStatus, "PROCESSING");
  assert.equal(result.bankPayment, undefined);
  assert.equal(f.control.posts, 1);
  f.control.status = "COMPLETED";
  assert.equal((await restarted.status(prepared.fundingId)).state, "provider_completed");
});

test("a delayed processing confirmation advances an order after an overlapping INIT refresh", async t => {
  const f = fixture(t);
  const prepared = await f.service.prepare({ amountNgn: "5000" });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const delayed: JsonRequest = async (url, options) => {
    const response = await f.request(url, options);
    started();
    await held;
    return response;
  };
  f.control.status = "PROCESSING";
  const service = new FundingService(f.config, f.store, delayed, f.wallet, () => f.control.now);
  const pending = service.status(prepared.fundingId);
  await waiting;
  f.control.status = "INIT";
  await f.service.status(prepared.fundingId);
  release();
  const result = await pending;
  assert.equal(result.state, "processing");
  assert.equal(result.bankPayment, undefined);
  assert.equal((await f.service.status(prepared.fundingId)).bankPayment, undefined);
  assert.equal(f.control.posts, 1);
});

test("reconciliation after processing cannot be cleared by an INIT response", async t => {
  const f = fixture(t);
  const prepared = await f.service.prepare({ amountNgn: "5000" });
  f.control.status = "PROCESSING";
  await f.service.status(prepared.fundingId);
  f.control.patch = { accountNumber: "9999999999" };
  await assert.rejects(f.service.status(prepared.fundingId), code("FUNDING_ORDER_CHANGED"));
  f.control.patch = {};
  f.control.status = "INIT";
  const result = await f.service.status(prepared.fundingId);
  assert.equal(result.state, "reconciliation_required");
  assert.equal(result.providerStatus, "PROCESSING");
  assert.equal(result.lastErrorCode, "FUNDING_ORDER_CHANGED");
  assert.equal(result.bankPayment, undefined);
});

test("a stale funding save cannot clear a newer reconciliation result with the same state", async t => {
  const f = fixture(t);
  const prepared = await f.service.prepare({ amountNgn: "5000" });
  f.control.patch = { accountNumber: "9999999999" };
  await assert.rejects(f.service.status(prepared.fundingId));
  const stale = f.store.funding(prepared.fundingId);
  f.control.now += 73 * 60 * 60_000;
  f.control.failStatus = true;
  await assert.rejects(f.service.status(prepared.fundingId));
  const newer = f.store.funding(prepared.fundingId);
  assert.equal(newer.state, stale.state);
  assert.notEqual(newer.lastErrorCode, stale.lastErrorCode);
  stale.state = "awaiting_fiat";
  delete stale.lastErrorCode;
  assert.equal(f.store.saveFunding(stale, "reconciliation_required"), false);
  assert.deepEqual(f.store.funding(prepared.fundingId), newer);
});

test("a late failed read returns the completion observed by another funding poll", async t => {
  const f = fixture(t);
  const prepared = await f.service.prepare({ amountNgn: "5000" });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const failedRead: JsonRequest = async () => { started(); await held; throw new Error("must-not-leak-late-read"); };
  const stale = new FundingService(f.config, f.store, failedRead, f.wallet, () => f.control.now);
  const pending = stale.status(prepared.fundingId);
  await waiting;
  f.control.status = "COMPLETED";
  const completed = await f.service.status(prepared.fundingId);
  release();
  assert.deepEqual(await pending, completed);
  assert.equal(f.store.funding(prepared.fundingId).state, "provider_completed");
});

test("existing funding records without a revision remain readable and can settle", async t => {
  const directory = mkdtempSync(join(tmpdir(), "agent-fiat-legacy-funding-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "profile.sqlite");
  const f = fixture(t, path);
  const prepared = await f.service.prepare({ amountNgn: "5000" });
  const legacy = f.store.funding(prepared.fundingId);
  delete legacy.revision;
  const db = new DatabaseSync(path);
  try { db.prepare("UPDATE funding_orders SET data=? WHERE id=?").run(JSON.stringify(legacy), legacy.id); }
  finally { db.close(); }
  f.control.status = "PROCESSING";
  assert.equal((await f.service.status(prepared.fundingId)).bankPayment, undefined);
  assert.equal(f.store.funding(prepared.fundingId).revision, 1);
  f.control.status = "COMPLETED";
  assert.equal((await f.service.status(prepared.fundingId)).state, "provider_completed");
  assert.equal(f.control.posts, 1);
});

test("funding persists across restarts and remains bound to the original receiving wallet", async t => {
  const directory = mkdtempSync(join(tmpdir(), "agent-fiat-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(t, join(directory, "profile.sqlite"));
  const first = await f.service.prepare({ amountNgn: "5000" });
  const secondStore = new Store(join(directory, "profile.sqlite"));
  t.after(() => secondStore.close());
  const restarted = new FundingService(f.config, secondStore, f.request, f.wallet, () => f.control.now);
  assert.equal((await restarted.prepare({ amountNgn: "5000" })).fundingId, first.fundingId);
  const different = new FundingService({ ...f.config, arcAddress: otherAddress }, secondStore, f.request, { ...f.wallet, address: otherAddress });
  await assert.rejects(different.status(first.fundingId), code("FUNDING_WALLET_CHANGED"));
  assert.deepEqual(different.history(), []);
  assert.equal(f.control.posts, 1);
});

test("changed funding details require reconciliation without releasing new payment instructions", async t => {
  for (const patch of [{ recipient: otherAddress }, { accountNumber: "9999999999" }, { accountName: "CHANGED NAME" }, { bank: "Changed Bank" }, { fiatAmount: 5100 }]) {
    const f = fixture(t);
    const first = await f.service.prepare({ amountNgn: "5000" });
    f.control.patch = patch;
    await assert.rejects(f.service.status(first.fundingId), code("FUNDING_ORDER_CHANGED"));
    assert.equal(f.store.funding(first.fundingId).state, "reconciliation_required");
    assert.equal(f.service.history()[0]?.accountEnding, undefined);
    await assert.rejects(f.service.prepare({ amountNgn: "5000" }));
    assert.equal(f.control.posts, 1);
  }
});

test("expired instructions are hidden while processing and uncertain settlement remain trackable", async t => {
  const f = fixture(t);
  const first = await f.service.prepare({ amountNgn: "5000" });
  f.control.now += 73 * 60 * 60_000;
  assert.equal(f.service.history()[0]?.accountEnding, undefined);
  f.control.status = "PROCESSING";
  assert.equal((await f.service.status(first.fundingId)).state, "processing");
  f.control.failStatus = true;
  await assert.rejects(f.service.status(first.fundingId));
  assert.equal(f.store.funding(first.fundingId).state, "reconciliation_required");
  f.control.failStatus = false;
  f.control.status = "COMPLETED";
  assert.equal((await f.service.status(first.fundingId)).state, "provider_completed");
  assert.equal(f.control.posts, 1);
});

test("an unpaid expired order releases its slot only after provider inspection", async t => {
  const f = fixture(t);
  const first = await f.service.prepare({ amountNgn: "5000" });
  f.control.now += 73 * 60 * 60_000;
  const expired = await f.service.status(first.fundingId);
  assert.equal(expired.state, "expired");
  assert.equal(expired.bankPayment, undefined);
  const next = await f.service.prepare({ amountNgn: "5000" });
  assert.notEqual(next.fundingId, first.fundingId);
  assert.equal(f.control.posts, 2);
});

test("stale or malformed funding creation never exposes unsafe instructions", async t => {
  for (const patch of [{ accountNumber: "short" }, { recipient: otherAddress }, { mint: otherAddress }, { status: "COMPLETED" }, { accountName: " " }, { bank: "Bank\nInjected line" }]) {
    const f = fixture(t);
    f.control.patch = patch;
    await assert.rejects(f.service.prepare({ amountNgn: "5000" }), code("FUNDING_CREATION_UNCERTAIN"));
    assert.equal(f.service.history()[0]?.state, "creation_uncertain");
    assert.equal(f.service.history()[0]?.accountEnding, undefined);
  }
  const f = fixture(t);
  f.control.age = 73 * 60 * 60_000;
  await assert.rejects(f.service.prepare({ amountNgn: "5000" }), code("FUNDING_CREATION_UNCERTAIN"));
});

test("late settlement remains trackable after expiry without overwriting a newer funding order", async t => {
  const f = fixture(t);
  const first = await f.service.prepare({ amountNgn: "5000" });
  f.control.now += 73 * 60 * 60_000;
  assert.equal((await f.service.status(first.fundingId)).state, "expired");
  const second = await f.service.prepare({ amountNgn: "6000" });
  f.control.status = "PROCESSING";
  assert.equal((await f.service.status(first.fundingId)).state, "processing");
  f.control.status = "COMPLETED";
  assert.equal((await f.service.status(first.fundingId)).state, "provider_completed");
  assert.equal(f.store.funding(second.fundingId).state, "awaiting_fiat");
  assert.equal(f.store.funding(second.fundingId).amountNgn, "6000");
  assert.equal(f.control.posts, 2);
});

test("MCP funding uses the configured wallet and rejects injected destination or approval fields", async t => {
  const f = fixture(t);
  const server = createMcpServer(new LiveService(f.config, f.store, f.request), { funding: f.service, readiness: async () => ({}) });
  const client = new Client({ name: "funding-client", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  assert.equal((await client.listTools()).tools.length, 12);
  for (const extra of [{ recipient: otherAddress }, { confirmed: true }, { currency: "USD" }]) assert.equal((await client.callTool({ name: "prepare_funding", arguments: { amountNgn: "5000", ...extra } })).isError, true);
  assert.equal(f.control.posts, 0);
  const response = await client.callTool({ name: "prepare_funding", arguments: { amountNgn: "5000" } });
  assert.equal(response.isError, undefined);
  const prepared = response.structuredContent as { result: { fundingId: string } };
  assert.equal((await client.callTool({ name: "funding_status", arguments: { fundingId: prepared.result.fundingId } })).isError, undefined);
  assert.equal((await client.callTool({ name: "funding_history", arguments: {} })).isError, undefined);
  assert.equal(f.control.posts, 1);
});

test("CLI documents funding and rejects missing or malformed input without using a live wallet", t => {
  const directory = mkdtempSync(join(tmpdir(), "agent-fiat-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^(OFFRAMP_|PAJ_|CIRCLE_|ARC_)/.test(entry[0])));
  Object.assign(env, { OFFRAMP_DATA_DIR: join(directory, "data"), CIRCLE_BIN: join(directory, "must-not-be-called") });
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env, encoding: "utf8", timeout: 15000 });
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /agent-fiat-mcp/);
  assert.match(help.stdout, /funding-status/);
  assert.equal(existsSync(join(directory, "data")), false);
  for (const args of [["fund"], ["funding-status", "not-an-id"], ["funding-history", "extra"]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    const error = result.stderr.split("\n").find(line => line.startsWith("{"));
    assert.equal(JSON.parse(error!).code, "INVALID_COMMAND");
  }
  assert.equal(existsSync(join(directory, "data")), false);
  const invalid = run(["fund", "0"]);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr.split("\n").find(line => line.startsWith("{"))!).code, "INVALID_AMOUNT");
});
