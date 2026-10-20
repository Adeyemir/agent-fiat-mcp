import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PajClient, PAJ_USDC, type JsonRequest } from "../src/providers/paj.js";
import { OfframpError, publicError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";
import { inspectReadiness } from "../src/readiness.js";

const code = (expected: string) => (error: unknown) => error instanceof OfframpError && error.code === expected;
const bank = { id: "bank_1", code: "999", name: "Example Bank", country: "NG" };
const rates = {
  offRampRate: { baseCurrency: "USD", targetCurrency: "NGN", rate: 1500, type: "offRamp", createdAt: "2026-10-20T10:00:00.000Z" },
  onRampRate: { baseCurrency: "USD", targetCurrency: "NGN", rate: 1525, type: "onRamp" },
};
const chains = [{ chain: "ARC", name: "Arc", isActive: true }, { chain: "BASE", name: "Base", isActive: false }];
const order = { id: "order_1", address: "0x2222222222222222222222222222222222222222", mint: PAJ_USDC.ARC, currency: "NGN", amount: 10.1, fiatAmount: 15000, fee: 0.1, chain: "ARC", status: "INIT", transactionType: "OFF_RAMP", createdAt: new Date().toISOString() };
function stub(response: unknown) {
  const calls: { url: string; options: RequestInit }[] = [];
  const request: JsonRequest = async (url, options = {}) => { calls.push({ url, options }); return url.endsWith("/chains") ? chains : response; };
  return { request, calls };
}

test("all v2 requests authenticate directly with the Business API key; rates include fees and are not locked", async () => {
  const { request, calls } = stub(rates);
  const client = new PajClient("production", "fake-api-key", request);
  const result = await client.rate();
  assert.equal(result.ngnPerUsdc, "1500");
  assert.equal(result.indicativeOnly, true);
  assert.equal(result.feesIncluded, true);
  assert.equal(result.providerUpdatedAt, rates.offRampRate.createdAt);
  assert.equal((await client.rate("onRamp")).ngnPerUsdc, "1525");
  assert.equal(calls[0]!.url, "https://api.paj.cash/pub/v2/rate?currency=NGN");
  for (const call of calls) {
    assert.equal(new Headers(call.options.headers).get("x-api-key"), "fake-api-key");
    assert.equal(new Headers(call.options.headers).has("Authorization"), false);
  }
  assert.equal(JSON.stringify(client).includes("fake-api-key"), false);
});

test("missing API keys, malformed keys and undocumented staging fail without an HTTP request", async () => {
  const { request, calls } = stub(rates);
  await assert.rejects(new PajClient("production", undefined, request).rate(), code("PROVIDER_API_KEY_REQUIRED"));
  await assert.rejects(new PajClient("staging", "fake-key", request).rate(), code("PROVIDER_ENVIRONMENT_UNVERIFIED"));
  assert.throws(() => new PajClient("production", "bad\r\nHeader:value", request), code("INVALID_CONFIG"));
  assert.equal(calls.length, 0);
});

test("wrong-currency rates and imprecise monetary values are refused", async () => {
  for (const patch of [{ targetCurrency: "GHS" }, { rate: "1.1234567" }, { rate: Number.NaN }, { rate: 10_000_000_000 }]) {
    const { request } = stub({ ...rates, offRampRate: { ...rates.offRampRate, ...patch } });
    await assert.rejects(new PajClient("production", "fake-key", request).rate());
  }
});

test("v2 bank verification registers by bank CODE and checks the exact returned account and full name", async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const request: JsonRequest = async (url, options = {}) => {
    calls.push({ url, options });
    return url.includes("/bank?") ? [bank, { ...bank, country: "GH", code: "998" }, { id: "nameless", code: "123", country: "NG" }] : { id: "reg_1", bank: bank.name, accountNumber: "0123456789", accountName: "USER TEST", address: "SolanaStandingAddressNeverForArc" };
  };
  const client = new PajClient("production", "fake-key", request);
  const verified = await client.verifyBank({ bank: "999", accountNumber: "0123456789", expectedName: "TEST USER" });
  assert.equal(verified.bankCode, "999");
  assert.equal(verified.bankId, "bank_1");
  assert.equal(calls[1]!.options.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1]!.options.body)), { bankCode: "999", accountNumber: "0123456789" });
  assert.equal(JSON.stringify(verified).includes("SolanaStandingAddress"), false);
  await assert.rejects(client.verifyBank({ bank: "999", accountNumber: "0123456789", expectedName: "OTHER USER" }), code("NAME_MISMATCH"));
  await assert.rejects(client.verifyBank({ bank: "998", accountNumber: "0123456789", expectedName: "TEST USER" }), code("BANK_SELECTION_REQUIRED"));
});

test("changed bank details and nameless directory entries cannot become recipients", async () => {
  for (const patch of [{ accountNumber: "1111111111" }, { bank: "Another Bank" }]) {
    const request: JsonRequest = async url => url.includes("/bank?") ? [bank] : { id: "reg_1", bank: bank.name, accountNumber: "0123456789", accountName: "TEST USER", ...patch };
    await assert.rejects(new PajClient("production", "fake-key", request).verifyBank({ bank: "999", accountNumber: "0123456789", expectedName: "TEST USER" }), code("BANK_DETAILS_CHANGED"));
  }
  const { request } = stub([bank, { id: "blank", code: "123", country: "NG", name: " " }]);
  assert.deepEqual(await new PajClient("production", "fake-key", request).banks(), [bank]);
});

test("direct Arc orders send the documented bankCode, chain and six-decimal USDC mint", async () => {
  const { request, calls } = stub(order);
  const result = await new PajClient("production", "fake-key", request).createOfframp({ bankCode: "999", accountNumber: "0123456789", receiveNgn: "15000" });
  const sent = JSON.parse(String(calls[1]!.options.body));
  assert.equal(calls[1]!.url, "https://api.paj.cash/pub/v2/offramp");
  assert.deepEqual(sent, { bankCode: "999", accountNumber: "0123456789", currency: "NGN", chain: "ARC", mint: PAJ_USDC.ARC, fiatAmount: 15000 });
  assert.equal(result.usdc, "10.1");
  assert.equal(result.providerFeeUsdc, "0.1"); // Not added to amount again.
});

test("both amount fields, unsafe numeric amounts and inactive chains cannot create an order", async () => {
  const { request, calls } = stub(order);
  const client = new PajClient("production", "fake-key", request);
  const input = { bankCode: "999", accountNumber: "0123456789" };
  await assert.rejects(client.createOfframp({ ...input, usdc: "10", receiveNgn: "15000" }), code("INVALID_AMOUNT"));
  await assert.rejects(client.createOfframp({ ...input, receiveNgn: "9007199254740992" }), code("INVALID_AMOUNT"));
  assert.equal(calls.length, 0);
  let writes = 0;
  const inactive: JsonRequest = async (_url, options) => { if (options?.method === "POST") writes++; return [{ chain: "ARC", name: "Arc", isActive: false }]; };
  await assert.rejects(new PajClient("production", "fake-key", inactive).createOfframp({ ...input, usdc: "10" }), code("PROVIDER_CHAIN_INACTIVE"));
  assert.equal(writes, 0);
});

test("changed quote currency, mint, chain, amount, status or destination is refused", async () => {
  for (const patch of [{ currency: "USD" }, { mint: "0x1111111111111111111111111111111111111111" }, { chain: "BASE" }, { amount: "10.1234567" }, { amount: "11" }, { status: "PENDDING" }, { address: "0x0000000000000000000000000000000000000000" }]) {
    const { request } = stub({ ...order, ...patch });
    await assert.rejects(new PajClient("production", "fake-key", request).createOfframp({ bankCode: "999", accountNumber: "0123456789", usdc: "10.1" }));
  }
});

test("transaction polling uses the singular v2 path and validates immutable order details", async () => {
  let altered = false;
  const calls: string[] = [];
  const request: JsonRequest = async url => { calls.push(url); return { ...order, amount: altered ? 20 : 10.1 }; };
  const client = new PajClient("production", "fake-key", request);
  const expected = await client.transaction("order_1");
  assert.equal(calls[0], "https://api.paj.cash/pub/v2/transaction/order_1");
  await client.checkOrder(expected);
  altered = true;
  await assert.rejects(client.checkOrder(expected), code("PROVIDER_ORDER_CHANGED"));
  await assert.rejects(client.transaction("../../another-business"), code("INVALID_PROVIDER_REFERENCE"));
});

test("onramp orders bind the saved receiving wallet and stop on currently inactive Base", async () => {
  const recipient = "0x1111111111111111111111111111111111111111";
  const { request, calls } = stub({ ...order, transactionType: "ON_RAMP", recipient, accountNumber: "1234567890", accountName: "Paj Inc.(Pay NGN 15,000.00)", bank: "Example Bank" });
  const client = new PajClient("production", "fake-key", request);
  const result = await client.createOnramp({ receiveAddress: recipient, chain: "ARC", spendNgn: "15000" });
  assert.equal(result.recipient, recipient);
  assert.deepEqual(JSON.parse(String(calls[1]!.options.body)), { fiatAmount: 15000, currency: "NGN", chain: "ARC", mint: PAJ_USDC.ARC, recipient });
  await assert.rejects(client.createOnramp({ receiveAddress: recipient, chain: "BASE", spendNgn: "15000" }), code("PROVIDER_CHAIN_INACTIVE"));
  assert.equal(calls.filter(call => call.options.method === "POST").length, 1);
});

test("readiness uses v2 reads and confirms the direct Arc route without a Gateway dependency", async () => {
  const calls: string[] = [];
  const request: JsonRequest = async (url, options = {}) => {
    calls.push(url); assert.equal(options.method, "GET");
    assert.equal(new Headers(options.headers).get("x-api-key"), "fake-key");
    return url.endsWith("/chains") ? chains : url.includes("/bank?") ? [bank] : rates;
  };
  const result = await inspectReadiness(loadConfig({ PAJ_API_KEY: "fake-key" }), request);
  assert.equal(result.provider.apiVersion, "v2");
  assert.equal(result.provider.arcOrdersAvailable, true);
  assert.equal(result.provider.directArcSettlementDocumented, true);
  assert.equal(result.provider.loginRequired, false);
  assert.equal(result.settlement.gatewayRequired, false);
  assert.equal(result.provider.ngnAmountGuaranteed, false);
  assert.equal(result.livePayoutsVerified, false);
  assert.equal(calls.some(url => url.includes("gateway")), false);
  assert.equal(JSON.stringify(result).includes("fake-key"), false);
});

test("legacy OTP sessions cannot authenticate v2 or trigger a new login", async t => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-v2-no-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "paj-session-production.json"), JSON.stringify({ token: "fake-old-token", expiresAt: "2999-01-01" }));
  let calls = 0;
  const result = await inspectReadiness(loadConfig({ OFFRAMP_DATA_DIR: dir, PAJ_SESSION_TOKEN: "fake-old-token" }), async () => { calls++; return rates; });
  assert.equal(result.provider.apiKeyConfigured, false);
  assert.equal(result.provider.accountAccess.ok, false);
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(result).includes("fake-old-token"), false);
});

test("provider failures neither expose raw bodies nor automatically retry order creation", async () => {
  let writes = 0;
  const request: JsonRequest = async url => { if (url.endsWith("/chains")) return chains; writes++; throw new Error("fake-private-provider-body"); };
  try { await new PajClient("production", "fake-key", request).createOfframp({ bankCode: "999", accountNumber: "0123456789", usdc: "10" }); assert.fail("Expected failure"); }
  catch (error) { assert.equal(JSON.stringify(publicError(error)).includes("fake-private-provider-body"), false); }
  assert.equal(writes, 1);
});
