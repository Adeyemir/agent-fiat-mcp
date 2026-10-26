import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readArcReceipt } from "../src/adapters/arc-receipt.js";
import { loadConfig } from "../src/config.js";
import { OfframpError } from "../src/errors.js";
import { FundingService } from "../src/funding-service.js";
import { LiveService } from "../src/live-service.js";
import { createMcpServer } from "../src/mcp.js";
import { PAJ_USDC, type JsonRequest, type PajOrder } from "../src/providers/paj.js";
import { ReceiptService } from "../src/receipt-service.js";
import { arcExplorerUrl, receiptBalanceDelta, renderReceipt, saveReceipt } from "../src/receipt.js";
import type { ArcReceiptEvidence, ReceiptRecord } from "../src/receipt-types.js";
import { Store } from "../src/store.js";

const address = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const id = "11111111-1111-4111-8111-111111111111";
const payoutId = "22222222-2222-4222-8222-222222222222";
const hash = `0x${"a".repeat(64)}` as const;
const blockHash = `0x${"b".repeat(64)}` as const;
const createdAt = "2026-10-25T13:45:23.657Z";
const completedAt = "2026-10-25T13:51:23.651Z";
const evidence: ArcReceiptEvidence = { status: "confirmed", blockNumber: "16", blockHash, confirmations: "2", timestamp: "2026-10-25T13:50:09.000Z" };
const code = (value: string) => (error: unknown) => error instanceof OfframpError && error.code === value;

function input(): ReceiptRecord {
  return { id, kind: "funding", providerOrderId: "provider_order", pajStatus: "COMPLETED", amountNgn: "1391.68", amountUsdc: "1", walletAddress: address, timestamp: evidence.timestamp!, timestampSource: "Arc block", transactionHash: hash, explorerUrl: arcExplorerUrl(hash), arc: evidence, balanceBeforeUsdc: "0.531872", balanceAfterUsdc: "1.531872", balanceObservedAt: completedAt };
}

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "agent-fiat-receipts-"));
  const config = loadConfig({ OFFRAMP_DATA_DIR: dir, CIRCLE_ARC_ADDRESS: address, PAJ_API_KEY: "fake-receipt-key", CIRCLE_BIN: join(dir, "must-not-be-called") });
  const store = new Store(join(dir, "offramp-live-production-mainnet.sqlite"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const order: PajOrder = { id: "provider_order", depositAddress: other, mint: PAJ_USDC.ARC, currency: "NGN", usdc: "1", ngn: "1391.68", chain: "ARC", status: "INIT", transactionType: "ON_RAMP", providerFeeUsdc: "0", createdAt, recipient: address };
  store.insertFunding({ id, walletKey: `production:mainnet:${address}`, walletAddress: address, amountNgn: "1391.68", state: "provider_completed", createdAt, completedAt, walletBalanceBeforeUsdc: "0.531872", order, providerStatus: "COMPLETED", finalProviderUsdc: "1", transactionHash: hash });
  store.insertLive({ id: payoutId, state: "provider_completed", bank: { bankId: "bank", bankCode: "999", bankName: "Example Bank", accountNumber: "1234567890", accountName: "TEST USER" }, order: { ...order, id: "payout_order", recipient: other, transactionType: "OFF_RAMP", usdc: "0.95" }, sourceAddress: address, createdAt, completedAt, approvalExpiresAt: createdAt, requested: { amount: "1", currency: "USDC" }, budgetUnits: "1000000", feeReserveUnits: "50000", estimatedFeeUnits: "10000", transactionHash: hash, providerStatus: "COMPLETED", finalProviderNgn: "1301.6", walletBalanceBeforeUsdc: "2" });
  let reads = 0;
  const service = new ReceiptService(config, store, { arc: async () => { reads++; return evidence; }, balance: async () => "1.531872", now: () => Date.parse(completedAt) });
  return { dir, config, store, service, reads: () => reads };
}

test("receipt rendering is deterministic and separates provider, wallet and chain evidence", () => {
  const record = input();
  const first = renderReceipt(record);
  assert.deepEqual(renderReceipt(record), first);
  assert.equal(receiptBalanceDelta(record), "+1");
  for (const value of ["NGN 1,391.68", "1 USDC", "COMPLETED (provider reported)", "Verified by Arc transfer logs", "+1 USDC (observed)", address, hash, "2026-10-25T13:50:09.000Z"]) assert.ok(first.text.includes(value));
  assert.ok(first.text.startsWith("+---"));
  assert.ok(first.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(first.svg.includes(`href="${arcExplorerUrl(hash)}"`));
  assert.equal(/<(?:script|image|foreignObject)\b|@import|url\(/i.test(first.svg), false);
  assert.ok(first.svg.includes('aria-labelledby="title description"'));
});

test("payout receipts never claim independently verified bank credit", () => {
  const rendered = renderReceipt({ ...input(), id: payoutId, kind: "payout", balanceBeforeUsdc: "2", balanceAfterUsdc: "1.04", amountUsdc: "0.95", amountNgn: "1301.6", recipient: { name: "TEST USER", bank: "Example Bank", accountEnding: "7890" } });
  assert.ok(rendered.text.includes("NGN 1,301.60"));
  assert.ok(rendered.text.includes("Not applicable - payout from wallet"));
  assert.ok(rendered.text.includes("Not independently verified"));
  assert.ok(rendered.text.includes("-0.96 USDC (observed)"));
  assert.ok(rendered.svg.includes("ending 7890"));
  assert.equal(rendered.svg.includes("1234567890"), false);
});

test("unknown receipt evidence stays unverified and rendering escapes SVG content", () => {
  const record = input();
  delete record.balanceBeforeUsdc;
  delete record.balanceAfterUsdc;
  delete record.transactionHash;
  delete record.explorerUrl;
  record.arc = { status: "not_recorded" };
  record.timestampSource = "Order created";
  record.recipient = { name: '<script>alert("x")</script>&', bank: "Bank & Co", accountEnding: "7890" };
  const rendered = renderReceipt(record);
  assert.equal(receiptBalanceDelta(record), undefined);
  assert.ok(rendered.text.includes("Not independently verified"));
  assert.ok(rendered.text.includes("Not recorded"));
  assert.ok(rendered.svg.includes("&lt;script&gt;"));
  assert.ok(rendered.svg.includes("Bank &amp; Co"));
  assert.equal(rendered.svg.includes("<script>"), false);
  assert.throws(() => renderReceipt({ ...input(), providerOrderId: "bad\nreference" }), code("INVALID_RECEIPT_DATA"));
  assert.throws(() => renderReceipt({ ...input(), explorerUrl: "javascript:alert(1)" }), code("INVALID_RECEIPT_URL"));
  assert.throws(() => renderReceipt({ ...input(), pajStatus: "INIT" as "COMPLETED" }), code("RECEIPT_NOT_READY"));
  assert.throws(() => renderReceipt({ ...input(), id: "../../outside" }), code("INVALID_RECEIPT_ID"));
});

test("SVG receipts use a stable private path and preserve unchanged file content", t => {
  const { dir } = fixture(t);
  const first = saveReceipt(dir, input());
  const before = statSync(first.svgPath).mtimeMs;
  const second = saveReceipt(dir, input());
  assert.deepEqual(second, first);
  assert.equal(first.svgPath, join(dir, "receipts", `${id}.svg`));
  assert.equal(readFileSync(first.svgPath, "utf8"), renderReceipt(input()).svg);
  assert.equal(statSync(first.svgPath).mtimeMs, before);
  if (process.platform !== "win32") { assert.equal(statSync(first.svgPath).mode & 0o777, 0o600); assert.equal(statSync(join(dir, "receipts")).mode & 0o777, 0o700); }
});

test("receipt retrieval is cached across restarts and bound to the original wallet", async t => {
  const f = fixture(t);
  const first = await f.service.get(id);
  const restarted = new ReceiptService(f.config, f.store, { arc: async () => { throw new Error("Must use checked evidence"); }, balance: async () => { throw new Error("Must preserve observation"); } });
  assert.deepEqual(await restarted.get(id), first);
  assert.equal(f.reads(), 1);
  await assert.rejects(new ReceiptService({ ...f.config, arcAddress: other }, f.store).get(id), code("RECEIPT_WALLET_CHANGED"));
  const pending = f.store.funding(id);
  pending.state = "processing";
  f.store.saveFunding(pending, "provider_completed");
  await assert.rejects(f.service.get(id), code("RECEIPT_NOT_READY"));
  await assert.rejects(f.service.get("33333333-3333-4333-8333-333333333333"), code("RECEIPT_NOT_FOUND"));
});

test("receipt verification can improve without overwriting previously verified evidence", async t => {
  const f = fixture(t);
  let arc: ArcReceiptEvidence = { status: "unavailable" };
  const service = new ReceiptService(f.config, f.store, { arc: async () => arc, balance: async () => "1.531872", now: () => Date.parse(completedAt) });
  assert.equal((await service.get(id)).data.arc.status, "unavailable");
  arc = evidence;
  assert.equal((await service.get(id)).data.arc.status, "confirmed");
  arc = { status: "unavailable" };
  assert.equal((await service.get(id)).data.arc.status, "confirmed");
  const legacy = f.store.funding(id);
  delete legacy.walletBalanceBeforeUsdc;
  f.store.saveFunding(legacy, "provider_completed");
  const withoutBaseline = await service.get(id);
  assert.ok(withoutBaseline.text.includes("Not recorded"));
  assert.equal(receiptBalanceDelta(withoutBaseline.data), undefined);
});

test("a receipt write failure preserves payment completion and cannot follow a directory symlink", async t => {
  const f = fixture(t);
  mkdirSync(join(f.dir, "outside"));
  symlinkSync(join(f.dir, "outside"), join(f.dir, "receipts"), "dir");
  const response = await f.service.attach({ state: "provider_completed", fundingId: id, walletCreditIndependentlyVerified: false });
  assert.equal(response.state, "provider_completed");
  assert.equal(response.receipt, undefined);
  assert.equal(response.receiptError?.code, "INVALID_RECEIPT_DIRECTORY");
  assert.equal(existsSync(join(f.dir, "outside", `${id}.svg`)), false);
  assert.equal(f.store.funding(id).state, "provider_completed");
  assert.equal(f.store.receipt(id), undefined);
});

test("Arc receipts verify the expected USDC leg and reject mismatches or unavailable evidence", async () => {
  const event = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
  const control = { chain: "0x13b2", status: "0x1", recipient: address, from: other, token: PAJ_USDC.ARC as string, amount: 1000000n, pending: false, fail: false };
  const request: JsonRequest = async (url, options) => {
    assert.equal(url, "https://rpc.mainnet.arc.io");
    assert.equal(new Headers(options?.headers).has("x-api-key"), false);
    const payload = JSON.parse(String(options?.body));
    if (control.fail) throw new Error("private-rpc-error");
    let result: unknown;
    if (payload.method === "eth_chainId") result = control.chain;
    else if (payload.method === "eth_getTransactionReceipt") result = control.pending ? null : { transactionHash: hash, status: control.status, blockNumber: "0x10", blockHash, logs: [{ address: control.token, data: encodeAbiParameters([{ type: "uint256" }], [control.amount]), topics: encodeEventTopics({ abi: [event], args: { from: control.from as `0x${string}`, to: control.recipient as `0x${string}` } }) }] };
    else if (payload.method === "eth_getBlockByNumber") result = { hash: blockHash, number: "0x10", timestamp: "0x68fccbe1" };
    else if (payload.method === "eth_blockNumber") result = "0x11";
    else assert.fail("Unexpected RPC method");
    return { jsonrpc: "2.0", id: 1, result };
  };
  const input = { kind: "funding" as const, transactionHash: hash, walletAddress: address, amountUsdc: "1" };
  assert.equal((await readArcReceipt(input, request)).status, "confirmed");
  control.recipient = other;
  assert.equal((await readArcReceipt(input, request)).status, "mismatch");
  control.recipient = address; control.amount = 999999n;
  assert.equal((await readArcReceipt(input, request)).status, "mismatch");
  control.amount = 1000000n; control.token = other;
  assert.equal((await readArcReceipt(input, request)).status, "mismatch");
  control.token = PAJ_USDC.ARC; control.chain = "0x1";
  assert.equal((await readArcReceipt(input, request)).status, "mismatch");
  control.chain = "0x13b2"; control.status = "0x0";
  assert.equal((await readArcReceipt(input, request)).status, "failed");
  control.status = "0x1"; control.pending = true;
  assert.equal((await readArcReceipt(input, request)).status, "pending");
  control.pending = false; control.fail = true;
  assert.deepEqual(await readArcReceipt(input, request), { status: "unavailable" });
  control.fail = false; control.from = address; control.recipient = other;
  assert.equal((await readArcReceipt({ ...input, kind: "payout", counterparty: other }, request)).status, "confirmed");
  assert.equal((await readArcReceipt({ ...input, kind: "payout", counterparty: address }, request)).status, "mismatch");
});

test("MCP completed statuses and get_receipt return formatted receipts without new payments", async t => {
  const f = fixture(t);
  const forbidden: JsonRequest = async () => { assert.fail("No provider order or payment request is permitted"); };
  const server = createMcpServer(new LiveService(f.config, f.store, forbidden), { funding: new FundingService(f.config, f.store, forbidden), receipts: f.service, readiness: async () => ({}) });
  const client = new Client({ name: "receipt-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  assert.equal((await client.listTools()).tools.length, 13);
  for (const [name, arguments_] of [["funding_status", { fundingId: id }], ["payout_status", { payoutId }]] as const) {
    const response = await client.callTool({ name, arguments: arguments_ });
    assert.equal(response.isError, undefined);
    const result = (response.structuredContent as { result: { state: string; receipt: { text: string; svgPath: string }; walletCreditIndependentlyVerified?: boolean; bankPaid?: boolean } }).result;
    assert.equal(result.state, "provider_completed");
    assert.ok(existsSync(result.receipt.svgPath));
    assert.ok(result.receipt.text.includes("RECEIPT"));
    assert.equal(result.bankPaid ?? false, false);
    if (name === "funding_status") assert.equal(result.walletCreditIndependentlyVerified, true);
    assert.ok((response as CallToolResult).content.some(part => part.type === "text" && part.text.startsWith("+---")));
  }
  assert.equal((await client.callTool({ name: "get_receipt", arguments: { id } })).isError, undefined);
  assert.equal((await client.callTool({ name: "get_receipt", arguments: { id, confirmed: true } })).isError, true);
});

test("CLI prints a completed cached receipt without accessing live wallets or APIs", async t => {
  const f = fixture(t);
  const receipt = await f.service.get(id);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(OFFRAMP_|PAJ_|CIRCLE_|ARC_)/.test(key))) as NodeJS.ProcessEnv;
  Object.assign(env, { OFFRAMP_DATA_DIR: f.dir, CIRCLE_ARC_ADDRESS: address, CIRCLE_BIN: f.config.circleBin });
  const response = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "receipt", id], { cwd: process.cwd(), env, encoding: "utf8", timeout: 15000 });
  assert.equal(response.status, 0, response.stderr);
  assert.ok(response.stdout.includes(receipt.text));
  assert.ok(response.stdout.includes(receipt.svgPath));
  const invalid = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "receipt", "../../outside"], { cwd: process.cwd(), env, encoding: "utf8", timeout: 15000 });
  assert.equal(invalid.status, 1);
  assert.ok(invalid.stderr.includes("INVALID_COMMAND"));
});
