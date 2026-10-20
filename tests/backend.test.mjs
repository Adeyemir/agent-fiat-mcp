import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { parse } from "jsonc-parser";
import { requestMessage } from "../src/hosted-protocol.ts";
import { PajClient, PAJ_USDC } from "../src/providers/paj.ts";
import { hostedTransport } from "../src/providers/hosted.ts";
import { bank, destination, fixture, source } from "./fixtures/live.ts";

const config = parse(readFileSync(new URL("../backend/wrangler.jsonc", import.meta.url), "utf8"));
const bankDirectory = [
  { id: bank.bankId, name: bank.bankName, code: bank.bankCode, country: "NG" },
];
const orderBody = (requestId = randomUUID()) => ({
  requestId,
  bankCode: bank.bankCode,
  accountNumber: bank.accountNumber,
  currency: "NGN",
  chain: "ARC",
  mint: PAJ_USDC.ARC,
  amount: 10,
});

async function setup(t, overrides = {}) {
  const temp = mkdtempSync(join(tmpdir(), "offramp-backend-test-"));
  const routes = [];
  const control = {
    status: "INIT",
    failOrder: false,
    redirect: false,
    receipt: {},
    calls: [],
    attempts: [],
    orders: new Map(),
  };
  const route = (path, method, action) => routes.push({ path, method, action });
  route("/pub/v2/chains", "GET", () => [{ chain: "ARC", name: "Arc", isActive: true }]);
  route("/pub/v2/bank?country=NG", "GET", () => bankDirectory);
  route("/pub/v2/bank-account", "POST", () => ({
    accountName: bank.accountName,
    accountNumber: bank.accountNumber,
    bank: bank.bankName,
  }));
  route("/pub/v2/rate?currency=NGN", "GET", () => ({
    offRampRate: { rate: 1500, baseCurrency: "USD", targetCurrency: "NGN", type: "offRamp" },
  }));
  route("/pub/v2/offramp", "POST", (options) => {
    if (control.failOrder) return { error: "fake-provider-private-body" };
    const body = JSON.parse(String(options.body));
    const id = `order_${control.orders.size + 1}`;
    const order = {
      id,
      address: destination,
      mint: PAJ_USDC.ARC,
      chain: "ARC",
      currency: "NGN",
      amount: body.amount ?? 10,
      fiatAmount: body.fiatAmount ?? Math.round(body.amount * 150000) / 100,
      fee: 0,
      status: "INIT",
      transactionType: "OFF_RAMP",
      createdAt: new Date().toISOString(),
    };
    control.orders.set(id, order);
    return order;
  });
  route(/^\/pub\/v2\/transaction\/[a-zA-Z0-9_-]+$/, "GET", (options) => {
    const id = options.path.split("/").at(-1);
    assert.ok(control.orders.has(id));
    return { ...control.orders.get(id), status: control.status, ...control.receipt };
  });
  const outboundService = async (request) => {
    const url = new URL(request.url);
    control.attempts.push({
      origin: url.origin,
      path: url.pathname,
      providerKeyMatches: request.headers.get("x-api-key") === "fake-provider-key",
    });
    assert.equal(url.origin, "https://api.paj.cash");
    assert.equal(request.headers.get("x-api-key"), "fake-provider-key");
    const path = url.pathname + url.search;
    const route = routes.find(
      (route) =>
        route.method === request.method &&
        (typeof route.path === "string" ? route.path === path : route.path.test(path)),
    );
    assert.ok(route, `Unexpected upstream request: ${request.method} ${path}`);
    control.calls.push({ path, method: request.method });
    if (control.redirect)
      return new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.example" },
      });
    const value = route.action({ path, method: request.method, body: await request.text() });
    return Response.json(value, { status: value.error ? 503 : 200 });
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      scriptPath: fileURLToPath(new URL("../backend-dist/index.js", import.meta.url)),
      modules: true,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      cf: false,
      d1Databases: { DB: "test-db" },
      bindings: {
        ...config.vars,
        PAJ_API_KEY: "fake-provider-key",
        IP_HASH_SECRET: "fixture-secret-with-at-least-32-characters",
        ...overrides,
      },
      outboundService,
    }),
  );
  t.after(async () => {
    await mf.dispose();
    rmSync(temp, { recursive: true, force: true });
  });
  const db = await mf.getD1Database("DB");
  for (const statement of readFileSync(
    new URL("../backend/migrations/0001_initial.sql", import.meta.url),
    "utf8",
  )
    .split(";")
    .filter((value) => value.trim()))
    await db.prepare(statement).run();
  const url = (await mf.ready).origin;
  const nativeFetch = globalThis.fetch;
  const request = (target, options = {}) => {
    const headers = new Headers(options.headers);
    headers.set("cf-connecting-ip", "192.0.2.1");
    return nativeFetch(target, { ...options, headers });
  };
  const actor = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    const signed = async (path, input, age = 0) => {
      const body = input === undefined ? "" : JSON.stringify(input);
      const method = input === undefined ? "GET" : "POST";
      const time = String(Date.now() + age);
      const nonce = randomUUID();
      const signature = sign(
        null,
        Buffer.from(await requestMessage(method, url + path, time, nonce, body)),
        privateKey,
      ).toString("base64url");
      return {
        method,
        headers: {
          "content-type": "application/json",
          "x-offramp-key": key,
          "x-offramp-time": time,
          "x-offramp-nonce": nonce,
          "x-offramp-signature": signature,
        },
        ...(body ? { body } : {}),
      };
    };
    return {
      signed,
      call: async (path, input, age) => request(url + path, await signed(path, input, age)),
    };
  };
  return { temp, mf, db, url, request, nativeFetch, control, actor };
}

test("the real Worker rejects missing, tampered, stale and replayed signatures before contacting PAJ", async (t) => {
  const f = await setup(t);
  assert.equal((await f.request(f.url + "/v1/chains")).status, 401);
  const actor = f.actor();
  const signed = await actor.signed("/v1/offramp", orderBody());
  const changed = { ...JSON.parse(signed.body), amount: 20 };
  assert.equal(
    (await f.request(f.url + "/v1/offramp", { ...signed, body: JSON.stringify(changed) })).status,
    401,
  );
  assert.equal(
    (await f.request(f.url + "/v1/bank?country=NG", await actor.signed("/v1/chains"))).status,
    401,
  );
  assert.equal((await actor.call("/v1/chains", undefined, -120000)).status, 401);
  assert.equal(f.control.calls.length, 0);
  const valid = await actor.signed("/v1/chains");
  const response = await f.request(f.url + "/v1/chains", valid);
  assert.equal(
    response.status,
    200,
    JSON.stringify({ response: await response.json(), attempts: f.control.attempts }),
  );
  assert.equal((await f.request(f.url + "/v1/chains", valid)).status, 409);
  assert.equal(f.control.calls.length, 1);
});

test("orders are isolated per installation and duplicate requests never create another PAJ order", async (t) => {
  const f = await setup(t);
  const a = f.actor(),
    b = f.actor();
  const input = orderBody();
  const [first, concurrent] = await Promise.all([
    a.call("/v1/offramp", input),
    a.call("/v1/offramp", input),
  ]);
  assert.ok([first.status, concurrent.status].includes(201));
  assert.ok([200, 201, 409].includes(concurrent.status));
  const paid = await a.call("/v1/offramp", input);
  assert.equal(paid.status, 201);
  const order = await paid.json();
  assert.equal(f.control.calls.filter((call) => call.path === "/pub/v2/offramp").length, 1);
  const calls = f.control.calls.length;
  assert.equal((await b.call(`/v1/transaction/${order.id}`)).status, 404);
  assert.equal(f.control.calls.length, calls);
  assert.equal((await a.call(`/v1/transaction/${order.id}`)).status, 200);
  assert.equal((await a.call("/v1/offramp", { ...input, amount: 11 })).status, 409);
  assert.equal((await a.call("/v1/offramp", { ...orderBody(), chain: "BASE" })).status, 400);
  assert.equal(
    (await a.call("/v1/offramp", { ...orderBody(), webhookURL: "https://example.com" })).status,
    400,
  );
  assert.equal((await a.call("/v1/offramp", { ...orderBody(), amount: 101 })).status, 400);
});

test("a failed upstream order remains uncertain and its request cannot be retried into a new order", async (t) => {
  const f = await setup(t);
  const actor = f.actor(),
    input = orderBody();
  f.control.failOrder = true;
  const first = await actor.call("/v1/offramp", input);
  assert.equal(first.status, 503);
  const failure = JSON.stringify(await first.json());
  assert.ok(!failure.includes("fake-provider-key"));
  assert.ok(!failure.includes("fake-provider-private-body"));
  f.control.failOrder = false;
  assert.equal((await actor.call("/v1/offramp", input)).status, 409);
  assert.equal(f.control.calls.filter((call) => call.path === "/pub/v2/offramp").length, 1);
});

test("upstream redirects cannot forward the server's provider credential to another host", async (t) => {
  const f = await setup(t);
  f.control.redirect = true;
  assert.equal((await f.actor().call("/v1/chains")).status, 502);
  assert.equal(f.control.attempts.length, 1);
  assert.equal(f.control.attempts[0].origin, "https://api.paj.cash");
});

test("the Worker enforces shared request and per-installation order allowances", async (t) => {
  const f = await setup(t, { ORDERS_PER_INSTALLATION_DAY: "1", REQUESTS_PER_MINUTE: "3" });
  const actor = f.actor();
  assert.equal((await actor.call("/v1/offramp", orderBody())).status, 201);
  assert.equal((await actor.call("/v1/offramp", orderBody())).status, 429);
  assert.equal((await actor.call("/v1/chains")).status, 200);
  assert.equal((await actor.call("/v1/chains")).status, 429);
  assert.equal(f.control.calls.filter((call) => call.path === "/pub/v2/offramp").length, 1);
});

test("the npm provider connects without a PAJ key and preserves its private identity across restarts", async (t) => {
  const f = await setup(t);
  const dataDir = join(f.temp, "client");
  const provider = () =>
    new PajClient("production", undefined, undefined, hostedTransport(f.url, dataDir, f.request));
  assert.equal((await provider().rate()).ngnPerUsdc, "1500");
  assert.equal(
    (
      await provider().verifyBank({
        bank: bank.bankCode,
        accountNumber: bank.accountNumber,
        expectedName: bank.accountName,
      })
    ).accountName,
    bank.accountName,
  );
  const order = await provider().createOfframp({
    bankCode: bank.bankCode,
    accountNumber: bank.accountNumber,
    usdc: "10",
  });
  assert.equal((await provider().transaction(order.id)).id, order.id);
  assert.equal(statSync(join(dataDir, "service-identity.json")).mode & 0o777, 0o600);
  const other = new PajClient(
    "production",
    undefined,
    undefined,
    hostedTransport(f.url, join(f.temp, "other-client"), f.request),
  );
  await assert.rejects(other.transaction(order.id), (error) => error.code === "ORDER_NOT_FOUND");
});

test("the existing payout lifecycle works through the real hosted Worker with no client PAJ key", async (t) => {
  const f = await setup(t);
  const payout = fixture(t, join(f.temp, "offramp.sqlite"));
  delete payout.config.pajApiKey;
  payout.config.backendUrl = f.url;
  payout.config.dataDir = join(f.temp, "payout-client");
  globalThis.fetch = (target, options) =>
    String(target).startsWith(f.url) ? f.request(target, options) : f.nativeFetch(target, options);
  t.after(() => {
    globalThis.fetch = f.nativeFetch;
  });
  const quote = await payout.service.prepare({ amount: "10", currency: "USDC" });
  assert.equal(payout.transfers.length, 0);
  await assert.rejects(
    payout.service.execute(quote.payoutId, async () => false),
    (error) => error.code === "APPROVAL_REQUIRED",
  );
  await payout.service.execute(quote.payoutId, async () => true);
  assert.equal(payout.transfers.length, 1);
  f.control.status = "COMPLETED";
  f.control.receipt = { signature: `0x${"a".repeat(64)}`, sender: source, recipient: destination };
  assert.equal((await payout.service.status(quote.payoutId)).state, "provider_completed");
  await payout.service.execute(quote.payoutId, async () => true);
  assert.equal(payout.transfers.length, 1);
});
