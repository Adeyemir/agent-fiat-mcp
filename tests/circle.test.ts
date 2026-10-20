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
const token = {
  name: "USDC",
  symbol: "USDC",
  blockchain: "ARC",
  decimals: 6,
  isNative: false,
  tokenAddress: "0x3600000000000000000000000000000000000000",
};
const balance = { amount: "1.358872", token };

function fakeCircle(
  t: test.TestContext,
  version = "1.2.2",
  fail = false,
  response: unknown = { data: { balances: [balance] } },
) {
  const dir = mkdtempSync(join(tmpdir(), "offramp-fake-cli-"));
  const binary = join(dir, "circle.mjs");
  const log = join(dir, "args.json");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
if (${fail}) { console.error('test-secret-never-return'); process.exit(1); }
const result = ${JSON.stringify(response)};
if (args[0] === 'wallet' && args[1] === 'list' && result.data?.wallets === undefined) {
  result.data = { wallets: [{ address: ${JSON.stringify(address)}, blockchain: 'ARC', type: 'agent' }] };
}
console.log(JSON.stringify(result));
`,
  );
  chmodSync(binary, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { agent: new CircleAgent(binary, address, "mainnet"), binary, log };
}

test("Arc USDC diagnostics request only the six-decimal token and keep the real decimal balance", async (t) => {
  const { agent, log } = fakeCircle(t, "1.2.2", false, { data: { balances: [balance] } });
  assert.equal(await agent.usdcBalance(), "1.358872");
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), [
    "wallet",
    "balance",
    "--address",
    address,
    "--chain",
    "ARC",
    "--token",
    token.tokenAddress,
    "--output",
    "json",
  ]);
});

test("the account service reads the configured Circle wallet balance", async (t) => {
  const { binary } = fakeCircle(t, "1.2.2", false, { data: { balances: [balance] } });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const service = new LiveService(
    loadConfig({ CIRCLE_BIN: binary, CIRCLE_ARC_ADDRESS: address }),
    store,
  );
  assert.deepEqual(await service.balance(), {
    mode: "live",
    simulated: false,
    source: "USDC on Arc",
    network: "mainnet",
    walletUsdc: "1.358872",
    spendableUsdc: null,
  });
});

test("a live wallet failure cannot fall back to a simulated balance", async (t) => {
  const { binary } = fakeCircle(t, "1.2.2", true);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const service = new LiveService(
    loadConfig({ CIRCLE_BIN: binary, CIRCLE_ARC_ADDRESS: address }),
    store,
  );
  await assert.rejects(
    service.balance(),
    (error: unknown) => error instanceof OfframpError && error.code === "CIRCLE_ERROR",
  );
});

test("a missing token or an explicit zero balance is zero, not a positive amount error", async (t) => {
  for (const balances of [[], [{ ...balance, amount: "0.000000" }]]) {
    const { agent } = fakeCircle(t, "1.2.2", false, { data: { balances } });
    assert.equal(await agent.usdcBalance(), "0");
  }
});

test("Arc gas estimates round native 18-decimal USDC up to six decimals without broadcasting", async (t) => {
  const { agent, log } = fakeCircle(t, "1.2.2", false, {
    data: {
      blockchain: "ARC",
      medium: { networkFee: "0.018635180183073475", networkFeeRaw: "0.006546315214950975" },
    },
  });
  assert.equal(await agent.estimateUsdcTransfer(address, "0.1"), "0.018636");
  const args = JSON.parse(readFileSync(log, "utf8"));
  assert.ok(args.includes("--estimate"));
  assert.equal(args.includes("--idempotency-key"), false);
});

test("Circle transfers bind chain, token, source, recipient, amount and persisted idempotency reference", async (t) => {
  const destination = "0x2222222222222222222222222222222222222222";
  const key = "11111111-1111-4111-8111-111111111111";
  const { agent, log } = fakeCircle(t, "1.2.2", false, {
    data: {
      id: "transaction_1",
      blockchain: "ARC",
      state: "CONFIRMED",
      sourceAddress: address,
      destinationAddress: destination,
      amounts: ["1.000000"],
      txHash: `0x${"a".repeat(64)}`,
    },
  });
  assert.equal((await agent.transferUsdc(destination, "1", key)).id, "transaction_1");
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), [
    "wallet",
    "transfer",
    destination,
    "--amount",
    "1",
    "--token",
    token.tokenAddress,
    "--address",
    address,
    "--chain",
    "ARC",
    "--idempotency-key",
    key,
    "--output",
    "json",
  ]);
  const wrong = fakeCircle(t, "1.2.2", false, {
    data: {
      id: "transaction_2",
      blockchain: "BASE",
      state: "CONFIRMED",
      sourceAddress: address,
      destinationAddress: destination,
      amounts: ["1"],
    },
  });
  await assert.rejects(
    wrong.agent.transferUsdc(destination, "1", key),
    (error: unknown) => error instanceof OfframpError && error.code === "CIRCLE_TRANSFER_UNCERTAIN",
  );
});

test("Arc balance checks refuse duplicate views, other networks and malformed amounts", async (t) => {
  const native = { ...balance, token: { ...token, decimals: 18, isNative: true } };
  const invalid = [
    [balance, native],
    [balance, balance],
    [native],
    [{ ...balance, token: { ...token, blockchain: "ARC-TESTNET" } }],
    [{ ...balance, token: { ...token, tokenAddress: address } }],
    ...["-1", "1e6", "1.0000001", 1, ""].map((amount) => [{ ...balance, amount }]),
  ];
  for (const balances of invalid) {
    const { agent } = fakeCircle(t, "1.2.2", false, { data: { balances } });
    await assert.rejects(
      agent.usdcBalance(),
      (error: unknown) => error instanceof OfframpError && error.code === "CIRCLE_BALANCE",
    );
  }
});

test("readiness authenticates the source agent wallet and reads its Arc balance", async (t) => {
  const { binary } = fakeCircle(t, "1.2.2", false, { data: { balances: [balance] } });
  const request: JsonRequest = async (url, options = {}) => {
    assert.equal(new Headers(options.headers).has("Authorization"), false);
    assert.ok(!options.method || options.method === "GET");
    if (url.endsWith("/chains")) return [{ chain: "ARC", name: "Arc", isActive: true }];
    if (url.includes("/bank?"))
      return [{ id: "bank_1", name: "Example Bank", code: "999", country: "NG" }];
    return {
      offRampRate: { baseCurrency: "USD", targetCurrency: "NGN", rate: 1500, type: "offRamp" },
    };
  };
  const config = loadConfig({
    PAJ_API_KEY: "fake-key",
    CIRCLE_BIN: binary,
    CIRCLE_ARC_ADDRESS: address,
  });
  const result = await inspectReadiness(config, request);
  assert.equal(result.livePayoutsAvailable, true);
  assert.ok("ok" in result.source.circle && result.source.circle.ok);
  assert.deepEqual(result.source.circle.result, {
    cliVersion: "1.2.2",
    walletAuthenticated: true,
    sourceNetwork: "mainnet",
    walletUsdc: "1.358872",
  });
  assert.equal(JSON.stringify(result).includes(address), false);
});

test("readiness rejects a source address absent from the authenticated agent wallets", async (t) => {
  const { binary } = fakeCircle(t, "1.2.2", false, { data: { wallets: [], balances: [balance] } });
  const request: JsonRequest = async (url) => {
    if (url.endsWith("/chains")) return [{ chain: "ARC", name: "Arc", isActive: true }];
    if (url.includes("/bank?"))
      return [{ id: "bank_1", name: "Example Bank", code: "999", country: "NG" }];
    return {
      offRampRate: { baseCurrency: "USD", targetCurrency: "NGN", rate: 1500, type: "offRamp" },
    };
  };
  const result = await inspectReadiness(
    loadConfig({ PAJ_API_KEY: "fake-key", CIRCLE_BIN: binary, CIRCLE_ARC_ADDRESS: address }),
    request,
  );
  assert.equal(result.livePayoutsAvailable, false);
  assert.ok("ok" in result.source.circle && !result.source.circle.ok);
  assert.equal(result.source.circle.error.code, "AGENT_WALLET_REQUIRED");
});

test("outdated Circle CLI is rejected", async (t) => {
  const { agent } = fakeCircle(t, "0.0.1");
  await assert.rejects(
    agent.checkVersion(),
    (error: unknown) => error instanceof OfframpError && error.code === "CIRCLE_VERSION",
  );
});

test("Circle operations default to Arc mainnet", async (t) => {
  const { binary, log } = fakeCircle(t);
  await new CircleAgent(binary, address).usdcBalance();
  const args = JSON.parse(readFileSync(log, "utf8"));
  assert.equal(args[args.indexOf("--chain") + 1], "ARC");
});

test("Circle stderr and provider bodies cannot leak through public tool errors", async (t) => {
  const { agent } = fakeCircle(t, "1.2.1", true);
  try {
    await agent.usdcBalance();
    assert.fail("Expected CLI failure");
  } catch (error) {
    const exposed = publicError(error);
    assert.equal(exposed.code, "CIRCLE_ERROR");
    assert.equal(JSON.stringify(exposed).includes("test-secret-never-return"), false);
  }
  assert.equal(
    JSON.stringify(publicError(new Error("test-secret-never-return"))).includes(
      "test-secret-never-return",
    ),
    false,
  );
});
