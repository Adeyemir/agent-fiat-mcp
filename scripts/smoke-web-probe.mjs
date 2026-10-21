import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Synthetic test connections only. Never call wallet or payout tools here.
const target = new URL(process.argv[2] ?? "http://127.0.0.1:8788");
assert.ok(
  !target.username &&
    !target.password &&
    !target.search &&
    !target.hash &&
    target.pathname === "/" &&
    (target.protocol === "https:" ||
      (target.protocol === "http:" && ["localhost", "127.0.0.1"].includes(target.hostname))),
  "Use an HTTPS origin or loopback HTTP origin.",
);
const endpoint = new URL("/mcp", target);
const post = (path, body, cookie) =>
  fetch(new URL(path, target), {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: target.origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
let client;
let transport;
let accessToken;
let clientId;

try {
  const health = await fetch(new URL("/health", target), { signal: AbortSignal.timeout(15_000) });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    service: "naira-offramp-web-probe",
    paymentsEnabled: false,
    walletConnected: false,
  });
  const discovery = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", target), {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal((await discovery.json()).resource, endpoint.href);
  assert.equal((await fetch(endpoint, { signal: AbortSignal.timeout(15_000) })).status, 401);
  const registered = await fetch(new URL("/register", target), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Automated connection smoke test",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(registered.status, 201);
  clientId = (await registered.json()).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL("/authorize", target);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "https://client.example/callback",
    state: "automated-connection-check",
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope: "offramp:probe",
    resource: endpoint.href,
  }).toString();
  const consent = await fetch(authorize, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(consent.status, 200);
  assert.equal(consent.headers.get("referrer-policy"), "same-origin");
  assert.ok(
    consent.headers
      .get("content-security-policy")
      ?.includes("form-action 'self' https://client.example;"),
  );
  const page = await consent.text();
  const request = /name="request" value="([^"]+)"/.exec(page)?.[1];
  const cookie = consent.headers.get("set-cookie")?.split(";")[0];
  assert.ok(request && cookie);
  const approved = await post("/consent", { request, decision: "allow" }, cookie);
  assert.equal(approved.status, 303);
  const browserCookie = approved.headers
    .getSetCookie()
    .find((value) => /^(?:__Host-)?offramp_probe_browser_/.test(value))
    ?.split(";")[0];
  assert.ok(browserCookie);
  const redirect = new URL(approved.headers.get("location"));
  assert.equal(redirect.origin, "https://client.example");
  const token = await post("/token", {
    client_id: clientId,
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code"),
    code_verifier: verifier,
    redirect_uri: "https://client.example/callback",
    resource: endpoint.href,
  });
  assert.equal(token.status, 200);
  accessToken = (await token.json()).access_token;
  client = new Client(
    { name: "automated-web-probe-smoke", version: "1" },
    { capabilities: { elicitation: { form: {} } } },
  );
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    assert.ok(request.params.message.includes("No wallet is connected"));
    prompts++;
    // Automated cancellation is protocol evidence, never evidence of a human UI.
    return { action: "cancel" };
  });
  transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: "Bearer " + accessToken } },
  });
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
    "get_browser_approval_test",
    "get_connection_readiness",
    "start_browser_approval_test",
    "test_human_approval",
  ]);
  const readiness = (await client.callTool({ name: "get_connection_readiness", arguments: {} }))
    .structuredContent.result;
  assert.equal(readiness.walletConnected, false);
  assert.equal(readiness.paymentExecutionAvailable, false);
  assert.equal(readiness.approvalUiVerified, false);
  assert.equal(readiness.browserApprovalTestAvailable, true);
  const browserTest = (
    await client.callTool({ name: "start_browser_approval_test", arguments: {} })
  ).structuredContent.result;
  const browserUrl = new URL(browserTest.browserUrl);
  assert.equal(browserUrl.origin, target.origin);
  assert.equal(browserTest.status, "pending");
  assert.equal((await fetch(browserUrl, { signal: AbortSignal.timeout(15_000) })).status, 403);
  const browserPage = await fetch(browserUrl, {
    headers: { Cookie: browserCookie },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(browserPage.status, 200);
  const browserHtml = await browserPage.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(browserHtml)?.[1];
  assert.ok(csrf);
  // Synthetic cancellation checks the HTTP exchange, not human interaction.
  const cancelled = await post(browserUrl.pathname, { csrf, decision: "cancel" }, browserCookie);
  assert.equal(cancelled.status, 303);
  assert.equal(cancelled.headers.get("location"), browserUrl.pathname);
  const browserResult = (
    await client.callTool({
      name: "get_browser_approval_test",
      arguments: { testId: browserTest.testId },
    })
  ).structuredContent.result;
  assert.equal(browserResult.status, "cancelled");
  assert.equal(browserResult.browserBoundResponseObserved, true);
  assert.equal(browserResult.humanInteractionIndependentlyVerified, false);
  assert.equal(browserResult.paymentExecutionAvailable, false);
  const observed = (await client.callTool({ name: "test_human_approval", arguments: {} }))
    .structuredContent.result;
  assert.equal(prompts, 1);
  assert.equal(observed.action, "cancel");
  assert.equal(observed.paymentExecutionAvailable, false);
  assert.equal(observed.humanInteractionIndependentlyVerified, false);
  console.log(
    JSON.stringify({
      endpoint: endpoint.href,
      oauth: "passed",
      tools: "4 compatibility tools",
      automatedBrowserExchange: "cancelled successfully",
      automatedFormExchange: "cancelled successfully",
      humanUiVerified: false,
      walletConnected: false,
      paymentsEnabled: false,
    }),
  );
} catch {
  console.error("Web probe smoke check failed. No wallet or payout tools were invoked.");
  process.exitCode = 1;
} finally {
  await transport?.terminateSession().catch(() => {});
  await client?.close();
  if (accessToken && clientId) {
    await post("/revoke", {
      client_id: clientId,
      token: accessToken,
      token_type_hint: "access_token",
    }).catch(() => {});
  }
}
