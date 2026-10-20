import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PajClient, PAJ_USDC, type JsonRequest, type PajChain, type PajSession } from "../src/providers/paj.js";
import { OfframpError, publicError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";
import { loadPajSession, savePajSession } from "../src/provider-session.js";
import { inspectReadiness } from "../src/readiness.js";

const code = (expected: string) => (error: unknown) => error instanceof OfframpError && error.code === expected;
const verifiedBank = { bankId: "bank_1", bankName: "Demo Test Bank", accountNumber: "0123456789", accountName: "TEST USER" };
const bankDirectory = [{ id: "bank_1", code: "999", name: "Demo Test Bank", country: "NG" }, { id: "bank_2", code: "998", name: "Other Country Bank", country: "GH" }];
const rate = { baseCurrency: "USD", targetCurrency: "NGN", rate: 1500.12, type: "offRamp", createdAt: "2026-10-19T10:00:00.000Z" };
const quotedOrder = { id: "order_1", address: "0x1111111111111111111111111111111111111111", mint: PAJ_USDC.MONAD.mainnet, currency: "NGN", amount: 10.1, fiatAmount: 15000, fee: 0.1 };

function stub(response: unknown) {
  const calls: { url: string; options: RequestInit }[] = [];
  const request: JsonRequest = async (url, options = {}) => { calls.push({ url, options }); return response; };
  return { request, calls };
}

test("public rates require no session and retain missing activity/expiry as unknown", async () => {
  const { request, calls } = stub(rate);
  const result = await new PajClient("staging", undefined, request).rate();
  assert.equal(result.ngnPerUsdc, "1500.12");
  assert.equal(result.indicativeOnly, true);
  assert.equal(result.active, null);
  assert.equal(result.providerUpdatedAt, rate.createdAt);
  assert.equal(calls[0]!.url, "https://api-staging.paj.cash/pub/rate/offRamp");
  assert.equal(new Headers(calls[0]!.options.headers).has("Authorization"), false);
});

test("inactive or wrong-currency rates and imprecise amounts are rejected", async () => {
  for (const patch of [{ isActive: false }, { targetCurrency: "GHS" }, { rate: "1.1234567" }, { rate: Number.NaN }, { rate: 10_000_000_000 }]) {
    const { request } = stub({ ...rate, ...patch });
    await assert.rejects(new PajClient("staging", undefined, request).rate());
  }
});

test("PAJ session endpoints alone receive the business key; OTPs are not stored on the client", async () => {
  const session = { token: "x".repeat(700), expiresAt: new Date(Date.now() + 60_000).toISOString(), isActive: "true" };
  const { request, calls } = stub(session);
  const client = new PajClient("staging", undefined, request);
  await client.initiateSession("test@example.invalid", "fake-business-key");
  const verified = await client.verifySession("test@example.invalid", "123456", "fake-business-key");
  assert.equal(verified.token.length, 700);
  assert.equal(verified.environment, "staging");
  assert.equal(new Headers(calls[0]!.options.headers).get("x-api-key"), "fake-business-key");
  assert.equal(new Headers(calls[0]!.options.headers).has("Authorization"), false);
  assert.deepEqual(JSON.parse(String(calls[0]!.options.body)), { email: "test@example.invalid" });
  assert.equal(JSON.parse(String(calls[1]!.options.body)).otp, "123456");
  assert.equal(JSON.stringify(client).includes("123456"), false);
  assert.equal(JSON.stringify(client).includes("fake-business-key"), false);
  await assert.rejects(client.banks(), code("PROVIDER_LOGIN_REQUIRED"));
});

test("inactive/expired sessions, malformed credentials and missing access fail before proceeding", async () => {
  const { request } = stub({ token: "fake-token", expiresAt: "2000-01-01", isActive: "true" });
  await assert.rejects(new PajClient("staging", undefined, request).verifySession("a@example.invalid", "123456", "fake-key"), code("INVALID_PROVIDER_SESSION"));
  assert.throws(() => new PajClient("staging", "bad\r\nHeader:value"), code("INVALID_CONFIG"));
  await assert.rejects(new PajClient("staging", undefined, request).banks(), code("PROVIDER_LOGIN_REQUIRED"));
});

test("bank resolution is restricted to NG and verifies the exact account and full holder name", async () => {
  const calls: string[] = [];
  const request: JsonRequest = async (url, options) => {
    calls.push(url);
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer fake-session");
    assert.equal(new Headers(options?.headers).has("x-api-key"), false);
    return url.endsWith("/pub/bank") ? bankDirectory : { accountName: "USER TEST", accountNumber: "0123456789", bank: { id: "bank_1", country: "NG" } };
  };
  const client = new PajClient("production", "fake-session", request);
  assert.equal((await client.banks()).length, 1);
  const bank = await client.verifyBank({ bank: "999", accountNumber: "0123456789", expectedName: "TEST USER" });
  assert.equal(bank.bankId, "bank_1");
  assert.ok(calls.at(-1)!.includes("bankId=bank_1&accountNumber=0123456789"));
  await assert.rejects(client.verifyBank({ bank: "998", accountNumber: "0123456789", expectedName: "TEST USER" }), code("BANK_SELECTION_REQUIRED"));
  await assert.rejects(client.verifyBank({ bank: "999", accountNumber: "0123456789", expectedName: "ANOTHER PERSON" }), code("NAME_MISMATCH"));
});

test("bank resolution and storage reject altered account numbers or banks", async () => {
  let changed = false;
  const request: JsonRequest = async url => url.endsWith("/pub/bank") ? bankDirectory : { accountName: "TEST USER", accountNumber: changed ? "0123456789" : "1111111111", bank: { id: changed ? "bank_other" : "bank_1", country: "NG" } };
  const client = new PajClient("staging", "fake-session", request);
  const input = { bank: "999", accountNumber: "0123456789", expectedName: "TEST USER" };
  await assert.rejects(client.verifyBank(input), code("BANK_DETAILS_CHANGED"));
  changed = true;
  await assert.rejects(client.verifyBank(input), code("BANK_DETAILS_CHANGED"));
  const saved = stub({ id: "saved_1", ...verifiedBank, bank: "bank_1" });
  assert.equal(await new PajClient("staging", "fake-session", saved.request).saveBank(verifiedBank), "saved_1");
  assert.deepEqual(JSON.parse(String(saved.calls[0]!.options.body)), { bankId: "bank_1", accountNumber: "0123456789" });
});

test("nameless production bank records cannot break the directory or become selectable recipients", async () => {
  const { request } = stub([
    ...bankDirectory,
    { id: "missing_name", code: "123", country: "NG" },
    { id: "blank_name", code: "124", country: "NG", name: "   " },
  ]);
  const client = new PajClient("production", "fake-session", request);
  assert.deepEqual(await client.banks(), [bankDirectory[0]]);
  await assert.rejects(client.verifyBank({ bank: "missing_name", accountNumber: "0123456789", expectedName: "TEST USER" }), code("BANK_SELECTION_REQUIRED"));
  await assert.rejects(client.verifyBank({ bank: "124", accountNumber: "0123456789", expectedName: "TEST USER" }), code("BANK_SELECTION_REQUIRED"));
});

test("order requests fix NGN and send the documented token/chain fields without adding a business fee", async () => {
  const { request, calls } = stub(quotedOrder);
  const response = await new PajClient("staging", "fake-session", request).createOfframp({ bankReference: "saved_1", accountNumber: "0123456789", receiveNgn: 15000n, chain: "MONAD", mint: PAJ_USDC.MONAD.mainnet });
  const sent = JSON.parse(String(calls[0]!.options.body));
  assert.equal(sent.fiatAmount, 15000);
  assert.equal(sent.currency, "NGN");
  assert.equal(sent.chain, "MONAD");
  assert.equal(sent.bank, "saved_1");
  assert.equal(sent.amount, undefined);
  assert.equal(sent.businessUSDCFee, undefined);
  assert.equal(response.usdc, "10.1");
  assert.equal(response.providerFeeUsdc, "0.1");
  assert.equal(response.expiresAt, undefined); // The API does not promise a TTL.
});

test("direct ARC orders, arbitrary tokens and unsafe numeric amounts are refused without an HTTP write", async () => {
  const { request, calls } = stub(quotedOrder);
  const client = new PajClient("staging", "fake-session", request);
  const input = { bankReference: "bank_1", accountNumber: "0123456789", receiveNgn: 15000n, chain: "MONAD" as const, mint: PAJ_USDC.MONAD.mainnet };
  await assert.rejects(client.createOfframp({ ...input, chain: "ARC" as PajChain }), code("UNSUPPORTED_SETTLEMENT_CHAIN"));
  await assert.rejects(client.createOfframp({ ...input, mint: "0x1111111111111111111111111111111111111111" }), code("INVALID_PROVIDER_TOKEN"));
  await assert.rejects(client.createOfframp({ ...input, receiveNgn: BigInt(Number.MAX_SAFE_INTEGER) + 1n }), code("INVALID_AMOUNT"));
  assert.equal(calls.length, 0);
});

test("changed quote amounts, chains, and case-sensitive token mints are rejected", async () => {
  const input = { bankReference: "bank_1", accountNumber: "0123456789", receiveNgn: 15000n, chain: "MONAD" as const, mint: PAJ_USDC.MONAD.mainnet };
  for (const patch of [{ fiatAmount: 14999 }, { chain: "SOLANA" }, { currency: "USD" }, { amount: "10.1234567" }]) {
    const { request } = stub({ ...quotedOrder, ...patch });
    await assert.rejects(new PajClient("staging", "fake-session", request).createOfframp(input));
  }
  const mint = PAJ_USDC.SOLANA.mainnet;
  const { request } = stub({ ...quotedOrder, mint: mint.toLowerCase(), address: mint });
  await assert.rejects(new PajClient("staging", "fake-session", request).createOfframp({ ...input, chain: "SOLANA", mint }), code("INVALID_PROVIDER_ORDER"));
});

test("existing PAJ orders are checked by ID and immutable details before any funding integration", async () => {
  let altered = false;
  const request: JsonRequest = async () => ({ ...quotedOrder, amount: altered ? 20 : 10.1, status: "INIT", transactionType: "OFF_RAMP" });
  const client = new PajClient("staging", "fake-session", request);
  const expected = await client.transaction("order_1");
  await client.checkOrder(expected);
  altered = true;
  await assert.rejects(client.checkOrder(expected), code("PROVIDER_ORDER_CHANGED"));
  await assert.rejects(client.transaction("../../other-account"), code("INVALID_PROVIDER_REFERENCE"));
});

test("private sessions are environment-specific, permission-restricted, and reject expiry", t => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-provider-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({ OFFRAMP_DATA_DIR: dir });
  const session: PajSession = { environment: "staging", token: "fake-test-session", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  savePajSession(config, session);
  const path = join(dir, "paj-session-staging.json");
  assert.equal(loadPajSession(config)?.token, "fake-test-session");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").includes("otp"), false);
  assert.equal(loadPajSession({ ...config, pajEnvironment: "production" }), undefined);
  writeFileSync(path, JSON.stringify({ ...session, expiresAt: "2000-01-01" }));
  assert.throws(() => loadPajSession(config), code("PROVIDER_SESSION_EXPIRED"));
});

test("readiness performs only public reads when not logged in and reports actual chain overlap", async () => {
  const calls: string[] = [];
  const request: JsonRequest = async (url, options = {}) => {
    calls.push(url);
    assert.ok(!options.method || options.method === "GET");
    assert.equal(new Headers(options.headers).has("Authorization"), false);
    if (url.includes("gateway-api")) return { domains: [{ chain: "Arc", domain: 26, network: "Testnet" }, { chain: "Solana", domain: 5, network: "Devnet" }] };
    return rate;
  };
  const config = loadConfig({ OFFRAMP_DATA_DIR: join(tmpdir(), "nonexistent-naira-offramp-profile") });
  const result = await inspectReadiness(config, request);
  assert.equal(result.livePayoutsAvailable, false);
  assert.equal(result.provider.directArcSettlementDocumented, false);
  assert.equal(result.provider.sessionConfigured, false);
  assert.equal(result.gateway.ok && result.gateway.result.arcSourceAvailable, true);
  assert.deepEqual(result.gateway.ok && result.gateway.result.providerSettlementOverlap, ["SOLANA"]);
  assert.equal(calls.length, 2);
  assert.equal(calls.some(url => url.includes("offramp") || url.includes("/initiate") || url.includes("/transfer")), false);
});

test("a valid PAJ session proves API access, never marks the unverified payout route ready", async () => {
  const request: JsonRequest = async (url, options = {}) => {
    if (url.includes("gateway-api")) return { domains: [{ chain: "Arc", domain: 26, network: "Mainnet" }, { chain: "Solana", domain: 5, network: "Mainnet" }] };
    if (url.endsWith("/pub/bank")) { assert.equal(new Headers(options.headers).get("Authorization"), "Bearer fake-session"); return bankDirectory; }
    return rate;
  };
  const config = loadConfig({ PAJ_ENVIRONMENT: "production", ARC_NETWORK: "mainnet", PAJ_SESSION_TOKEN: "fake-session" });
  const result = await inspectReadiness(config, request);
  assert.equal(result.provider.accountAccess.ok, true);
  assert.equal(result.livePayoutsAvailable, false);
  assert.ok(result.blockers.some(blocker => blocker.code === "SETTLEMENT_ACCEPTANCE_UNVERIFIED"));
  assert.equal(JSON.stringify(result).includes("fake-session"), false);
});

test("transport failures do not leak raw bodies or retry requests", async () => {
  let calls = 0;
  const request: JsonRequest = async () => { calls++; throw new Error("fake-private-provider-body"); };
  try { await new PajClient("production", "fake-session", request).banks(); assert.fail("Expected failure"); }
  catch (error) { assert.equal(JSON.stringify(publicError(error)).includes("fake-private-provider-body"), false); }
  assert.equal(calls, 1);
});
