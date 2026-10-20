import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CircleAgent } from "../src/adapters/circle.js";
import { OfframpError, publicError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";
import { inspectReadiness } from "../src/readiness.js";
import type { JsonRequest } from "../src/providers/paj.js";
import { LiveService } from "../src/live-service.js";
import { Store } from "../src/store.js";

const address = "0x1111111111111111111111111111111111111111";
const token = { name: "USDC", symbol: "USDC", blockchain: "ARC", decimals: 6, isNative: false, tokenAddress: "0x3600000000000000000000000000000000000000" };
const balance = { amount: "1.358872", token };

function fakeCircle(t: test.TestContext, version = "1.2.1", fail = false, response: unknown = { data: { signature: "0x1234abcd" } }) {
  const dir = mkdtempSync(join(tmpdir(), "offramp-fake-cli-"));
  const binary = join(dir, "circle.mjs");
  const log = join(dir, "args.json");
  writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
if (${fail}) { console.error('test-secret-never-return'); process.exit(1); }
console.log(JSON.stringify(${JSON.stringify(response)}));
`);
  chmodSync(binary, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { agent: new CircleAgent(binary, address, "mainnet"), binary, log };
}

test("Circle signing uses the configured agent wallet on ARC and preserves typed data as one literal argument", async t => {
  const { agent, log } = fakeCircle(t);
  const typedData = { message: { memo: "quotes ' \" and $(not-a-command) `not-a-command`" } };
  assert.equal(await agent.signTypedData(typedData), "0x1234abcd");
  const args = JSON.parse(readFileSync(log, "utf8"));
  assert.deepEqual(args, ["wallet", "sign", "typed-data", JSON.stringify(typedData), "--address", address, "--chain", "ARC", "--output", "json"]);
});

test("Arc USDC diagnostics request only the six-decimal token and keep the real decimal balance", async t => {
  const { agent, log } = fakeCircle(t, "1.2.2", false, { data: { balances: [balance] } });
  assert.equal(await agent.usdcBalance(), "1.358872");
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["wallet", "balance", "--address", address, "--chain", "ARC", "--token", token.tokenAddress, "--output", "json"]);
});

test("the live account service reads the wallet instead of the simulator's 100 USDC ledger", async t => {
  const { binary } = fakeCircle(t, "1.2.2", false, { data: { balances: [balance] } });
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.initialiseDemo();
  const service = new LiveService(loadConfig({ CIRCLE_BIN: binary, CIRCLE_ARC_ADDRESS: address }), store);
  assert.deepEqual(await service.balance(), {
    mode: "live", simulated: false, source: "USDC on Arc", network: "mainnet",
    walletUsdc: "1.358872", spendableUsdc: null, payoutExecutionImplemented: true, livePayoutsVerified: false,
  });
  assert.equal(store.demoBalance(), 100_000_000n);
});

test("a live wallet failure cannot fall back to a simulated balance", async t => {
  const { binary } = fakeCircle(t, "1.2.2", true);
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.initialiseDemo();
  const service = new LiveService(loadConfig({ CIRCLE_BIN: binary, CIRCLE_ARC_ADDRESS: address }), store);
  await assert.rejects(service.balance(), (error: unknown) => error instanceof OfframpError && error.code === "CIRCLE_ERROR");
});

test("a missing token or an explicit zero balance is zero, not a positive amount error", async t => {
  for (const balances of [[], [{ ...balance, amount: "0.000000" }]]) {
    const { agent } = fakeCircle(t, "1.2.2", false, { data: { balances } });
    assert.equal(await agent.usdcBalance(), "0");
  }
});

test("Arc gas estimates round native 18-decimal USDC up to six decimals without broadcasting", async t => {
  const { agent, log } = fakeCircle(t, "1.2.2", false, { data: { blockchain: "ARC", medium: { networkFee: "0.018635180183073475", networkFeeRaw: "0.006546315214950975" } } });
  assert.equal(await agent.estimateUsdcTransfer(address, "0.1"), "0.018636");
  const args = JSON.parse(readFileSync(log, "utf8"));
  assert.ok(args.includes("--estimate"));
  assert.equal(args.includes("--idempotency-key"), false);
});

test("Circle transfers bind chain, token, source, recipient, amount and persisted idempotency reference", async t => {
  const destination = "0x2222222222222222222222222222222222222222";
  const key = "11111111-1111-4111-8111-111111111111";
  const { agent, log } = fakeCircle(t, "1.2.2", false, { data: { id: "transaction_1", blockchain: "ARC", state: "CONFIRMED", sourceAddress: address, destinationAddress: destination, amounts: ["1.000000"], txHash: `0x${"a".repeat(64)}` } });
  assert.equal((await agent.transferUsdc(destination, "1", key)).id, "transaction_1");
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["wallet", "transfer", destination, "--amount", "1", "--token", token.tokenAddress, "--address", address, "--chain", "ARC", "--idempotency-key", key, "--output", "json"]);
  const wrong = fakeCircle(t, "1.2.2", false, { data: { id: "transaction_2", blockchain: "BASE", state: "CONFIRMED", sourceAddress: address, destinationAddress: destination, amounts: ["1"] } });
  await assert.rejects(wrong.agent.transferUsdc(destination, "1", key), (error: unknown) => error instanceof OfframpError && error.code === "CIRCLE_TRANSFER_UNCERTAIN");
});

test("Arc balance checks refuse duplicate views, other networks and malformed amounts", async t => {
  const native = { ...balance, token: { ...token, decimals: 18, isNative: true } };
  const invalid = [
    [balance, native], [balance, balance], [native],
    [{ ...balance, token: { ...token, blockchain: "ARC-TESTNET" } }],
    [{ ...balance, token: { ...token, tokenAddress: address } }],
    ...["-1", "1e6", "1.0000001", 1, ""].map(amount => [{ ...balance, amount }]),
  ];
  for (const balances of invalid) {
    const { agent } = fakeCircle(t, "1.2.2", false, { data: { balances } });
    await assert.rejects(agent.usdcBalance(), (error: unknown) => error instanceof OfframpError && error.code === "CIRCLE_BALANCE");
  }
});

test("readiness separates real wallet and Arc Gateway balances without enabling demo payments to spend them", async t => {
  const { binary } = fakeCircle(t, "1.2.2", false, { data: { balances: [balance] } });
  const request: JsonRequest = async (url, options = {}) => {
    assert.equal(new Headers(options.headers).has("Authorization"), false);
    if (url.endsWith("/v1/balances")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(String(options.body)), { token: "USDC", sources: [{ domain: 26, depositor: address }] });
      return { token: "USDC", balances: [{ domain: 26, depositor: address, balance: "2.000000" }] };
    }
    assert.ok(!options.method || options.method === "GET");
    if (url.endsWith("/v1/info")) return { domains: [{ chain: "Arc", domain: 26, network: "Mainnet" }] };
    return { baseCurrency: "USD", targetCurrency: "NGN", rate: 1500, type: "offRamp" };
  };
  const config = loadConfig({ OFFRAMP_MODE: "demo", CIRCLE_BIN: binary, CIRCLE_ARC_ADDRESS: address, ARC_NETWORK: "mainnet", OFFRAMP_DATA_DIR: join(tmpdir(), "nonexistent-naira-offramp-profile") });
  const result = await inspectReadiness(config, request);
  assert.equal(result.mode, "demo");
  assert.equal(result.livePayoutsAvailable, false);
  assert.ok("ok" in result.source.circle && result.source.circle.ok);
  assert.deepEqual(result.source.circle.result, { cliVersion: "1.2.2", walletAuthenticated: true, sourceNetwork: "mainnet", walletUsdc: "1.358872", gatewayArcUsdc: { ok: true, result: "2" }, diagnosticOnly: true, simulated: false });
  assert.equal(JSON.stringify(result).includes(address), false);
});

test("a failed Gateway balance read preserves the successful wallet check", async t => {
  const { binary } = fakeCircle(t, "1.2.2", false, { data: { balances: [balance] } });
  const request: JsonRequest = async url => {
    if (url.endsWith("/v1/balances")) throw new Error("fake-private-response");
    if (url.endsWith("/v1/info")) return { domains: [] };
    return { baseCurrency: "USD", targetCurrency: "NGN", rate: 1500, type: "offRamp" };
  };
  const result = await inspectReadiness(loadConfig({ CIRCLE_BIN: binary, CIRCLE_ARC_ADDRESS: address, ARC_NETWORK: "mainnet", OFFRAMP_DATA_DIR: join(tmpdir(), "nonexistent-naira-offramp-profile") }), request);
  assert.ok("ok" in result.source.circle && result.source.circle.ok);
  assert.equal(result.source.circle.result.walletUsdc, "1.358872");
  assert.equal(result.source.circle.result.gatewayArcUsdc.ok, false);
  assert.equal(JSON.stringify(result).includes("fake-private-response"), false);
});

test("outdated Circle CLI is rejected before requesting a signature", async t => {
  const { agent } = fakeCircle(t, "0.0.1");
  await assert.rejects(agent.signTypedData({}), (error: unknown) => error instanceof OfframpError && error.code === "CIRCLE_VERSION");
});

test("Circle signing defaults to Arc Testnet unless mainnet is explicitly selected", async t => {
  const { binary, log } = fakeCircle(t);
  await new CircleAgent(binary, address).signTypedData({});
  const args = JSON.parse(readFileSync(log, "utf8"));
  assert.equal(args[args.indexOf("--chain") + 1], "ARC-TESTNET");
});

test("Circle stderr and provider bodies cannot leak through public tool errors", async t => {
  const { agent } = fakeCircle(t, "1.2.1", true);
  try { await agent.signTypedData({}); assert.fail("Expected CLI failure"); }
  catch (error) {
    const exposed = publicError(error);
    assert.equal(exposed.code, "CIRCLE_ERROR");
    assert.equal(JSON.stringify(exposed).includes("test-secret-never-return"), false);
  }
  assert.equal(JSON.stringify(publicError(new Error("test-secret-never-return"))).includes("test-secret-never-return"), false);
});
