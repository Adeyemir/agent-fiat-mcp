import test from "node:test";
import assert from "node:assert/strict";
import { arcGatewayBalance } from "../src/adapters/gateway.js";
import { OfframpError } from "../src/errors.js";

const address = "0x1111111111111111111111111111111111111111";
const source = { domain: 26, depositor: address, balance: "4.892670" };

test("Gateway balance queries pin the network and depositor and parse human USDC decimals", async () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const result = await arcGatewayBalance(address, network, async (url, options) => {
      assert.equal(url, `https://gateway-api${network === "mainnet" ? "" : "-testnet"}.circle.com/v1/balances`);
      assert.equal(options?.method, "POST");
      assert.deepEqual(JSON.parse(String(options.body)), { token: "USDC", sources: [{ domain: 26, depositor: address }] });
      assert.equal(new Headers(options.headers).has("Authorization"), false);
      return { token: "USDC", balances: [source] };
    });
    assert.equal(result, "4.89267");
  }
});

test("Gateway accepts empty and explicit zero balances", async () => {
  for (const balances of [[], [{ ...source, balance: "0.000000" }]]) {
    assert.equal(await arcGatewayBalance(address, "mainnet", async () => ({ token: "USDC", balances })), "0");
  }
});

test("Gateway cannot count another source, depositor, duplicated entry or malformed balance", async () => {
  const invalid = [
    { token: "USDT", balances: [source] },
    { token: "USDC", balances: [source, source] },
    ...[{ domain: 0 }, { depositor: "0x2222222222222222222222222222222222222222" }, { balance: "-1" }, { balance: "1e6" }, { balance: "1.1234567" }, { balance: 1 }].map(patch => ({ token: "USDC", balances: [{ ...source, ...patch }] })),
  ];
  for (const response of invalid) {
    await assert.rejects(arcGatewayBalance(address, "mainnet", async () => response), (error: unknown) => error instanceof OfframpError && error.code === "INVALID_GATEWAY_BALANCE");
  }
});
