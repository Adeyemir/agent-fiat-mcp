import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ElicitRequestSchema,
  type CallToolResult,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createWebProbeServer, webProbeOrigin } from "../src/web-probe.js";

const origin = "http://127.0.0.1:8788";
const resource = origin + "/mcp";
const callback = "https://client.example/callback";
const result = (response: CallToolResult) =>
  response.structuredContent as {
    result?: Record<string, unknown>;
    error?: { code: string };
  };

async function fixture(t: test.TestContext, now: () => number = Date.now) {
  const probe = createWebProbeServer({ publicUrl: origin, now });
  const listening = once(probe.http, "listening");
  probe.http.listen(0, "127.0.0.1");
  await listening;
  const address = probe.http.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const connected: { client: Client; transport: StreamableHTTPClientTransport }[] = [];
  t.after(async () => {
    for (const item of connected) {
      await item.transport.terminateSession().catch(() => {});
      await item.client.close();
    }
    await probe.close();
  });
  const request = (path: string, init?: RequestInit) => fetch(base + path, init);

  async function register(clientName = "Compatibility tester") {
    const response = await request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [callback],
        client_name: clientName,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.equal(response.status, 201);
    return (await response.json()) as { client_id: string };
  }

  async function begin(clientId: string, overrides: Record<string, string> = {}) {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: callback,
      state: "test-state",
      scope: "offramp:probe offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
      ...overrides,
    });
    const response = await request("/authorize?" + query, { redirect: "manual" });
    const html = await response.text();
    const id = /name="request" value="([^"]+)"/.exec(html)?.[1];
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    return { response, html, id, cookie, verifier };
  }

  async function consent(
    pending: Awaited<ReturnType<typeof begin>>,
    decision = "allow",
    headers: Record<string, string> = {},
  ) {
    assert.ok(pending.id && pending.cookie);
    return request("/consent", {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: origin,
        Cookie: pending.cookie,
        ...headers,
      },
      body: new URLSearchParams({ request: pending.id, decision }),
    });
  }

  async function token(fields: Record<string, string>) {
    return request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }

  async function grant(existingClient?: string) {
    const clientId = existingClient ?? (await register()).client_id;
    const pending = await begin(clientId);
    assert.equal(pending.response.status, 200);
    const response = await consent(pending);
    assert.equal(response.status, 303);
    const redirect = new URL(response.headers.get("location")!);
    assert.equal(redirect.searchParams.get("state"), "test-state");
    const code = redirect.searchParams.get("code")!;
    assert.ok(code);
    const fields = {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: callback,
      code_verifier: pending.verifier,
      resource,
    };
    const exchanged = await token(fields);
    assert.equal(exchanged.status, 200);
    const tokens = (await exchanged.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    return { clientId, pending, fields, ...tokens };
  }

  async function connect(accessToken: string, answer?: ElicitResult) {
    const client = new Client(
      { name: "web-probe-test-client", version: "1" },
      { capabilities: answer ? { elicitation: { form: {} } } : {} },
    );
    const prompts: string[] = [];
    if (answer)
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        prompts.push(request.params.message);
        assert.equal(request.params.mode, "form");
        assert.ok(request.params.message.includes("will never approve a payment"));
        return answer;
      });
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + accessToken } },
    });
    connected.push({ client, transport });
    await client.connect(transport as Transport);
    return { client, transport, prompts };
  }
  return { ...probe, base, request, register, begin, consent, token, grant, connect };
}

test("web probe publishes OAuth discovery, requires bearer auth, and has no wallet access", async (t) => {
  const f = await fixture(t);
  const health = await f.request("/health");
  assert.deepEqual(await health.json(), {
    service: "naira-offramp-web-probe",
    paymentsEnabled: false,
    walletConnected: false,
  });
  const unauthenticated = await f.request("/mcp");
  assert.equal(unauthenticated.status, 401);
  assert.ok(
    unauthenticated.headers
      .get("www-authenticate")
      ?.includes(origin + "/.well-known/oauth-protected-resource/mcp"),
  );
  const metadata = await (await f.request("/.well-known/oauth-protected-resource/mcp")).json();
  assert.equal(metadata.resource, resource);
  assert.deepEqual(metadata.authorization_servers, [origin + "/"]);
  const auth = await (await f.request("/.well-known/oauth-authorization-server")).json();
  assert.deepEqual(auth.code_challenge_methods_supported, ["S256"]);
  assert.equal(auth.registration_endpoint, origin + "/register");
  const grant = await f.grant();
  const { client } = await f.connect(grant.access_token);
  assert.deepEqual((await client.listTools()).tools.map((item) => item.name).sort(), [
    "get_connection_readiness",
    "test_human_approval",
  ]);
  const readiness = result(
    (await client.callTool({ name: "get_connection_readiness", arguments: {} })) as CallToolResult,
  ).result!;
  assert.equal(readiness.walletConnected, false);
  assert.equal(readiness.paymentExecutionAvailable, false);
  assert.equal(readiness.formElicitationAdvertised, false);
  assert.equal(readiness.approvalUiVerified, false);
  assert.deepEqual(readiness.client, { name: "web-probe-test-client", version: "1" });
  assert.equal(
    (
      await client.callTool({
        name: "get_connection_readiness",
        arguments: { apiKey: "must-not-be-accepted" },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await client.callTool({
        name: "execute_payout",
        arguments: { payoutId: "does-not-exist" },
      })
    ).isError,
    true,
  );
});

test("browser consent escapes client text, requires its cookie and origin, and is single-use", async (t) => {
  const f = await fixture(t);
  const { client_id } = await f.register('<script>alert("client")</script>');
  const pending = await f.begin(client_id);
  assert.equal(pending.response.status, 200);
  assert.equal(pending.html.includes("<script>"), false);
  assert.ok(pending.html.includes("&lt;script&gt;"));
  assert.ok(pending.html.includes("cannot access a wallet"));
  assert.ok(pending.response.headers.get("set-cookie")?.includes("HttpOnly"));
  assert.equal(pending.response.headers.get("referrer-policy"), "no-referrer");
  assert.ok(
    pending.response.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"),
  );
  assert.equal(
    (await f.consent(pending, "allow", { Origin: "https://other.example" })).status,
    403,
  );
  assert.equal((await f.consent(pending, "allow", { Cookie: "" })).status, 403);
  const denied = await f.consent(pending, "deny");
  assert.equal(denied.status, 303);
  const redirect = new URL(denied.headers.get("location")!);
  assert.equal(redirect.origin, new URL(callback).origin);
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(redirect.searchParams.get("state"), "test-state");
  assert.equal(redirect.searchParams.has("code"), false);
  assert.equal((await f.consent(pending)).status, 403);
});

test("OAuth enforces PKCE, client, callback, resource, scope and one-time code bindings", async (t) => {
  const f = await fixture(t);
  const first = (await f.register()).client_id;
  const second = (await f.register()).client_id;
  const pending = await f.begin(first);
  const approved = await f.consent(pending);
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const fields = {
    client_id: first,
    grant_type: "authorization_code",
    code,
    code_verifier: pending.verifier,
    redirect_uri: callback,
    resource,
  };
  assert.equal((await f.token({ ...fields, client_id: second })).status, 400);
  assert.equal((await f.token({ ...fields, code_verifier: "wrong" })).status, 400);
  assert.equal(
    (await f.token({ ...fields, redirect_uri: "https://other.example/callback" })).status,
    400,
  );
  assert.equal((await f.token({ ...fields, resource: "https://other.example/mcp" })).status, 400);
  assert.equal((await f.token(fields)).status, 200);
  assert.equal((await f.token(fields)).status, 400);
  for (const overrides of [
    { scope: "offramp:pay" },
    { resource: "https://other.example/mcp" },
    { code_challenge_method: "plain" },
  ]) {
    const refused = await f.begin(first, overrides);
    assert.equal(refused.response.status, 302);
    assert.ok(new URL(refused.response.headers.get("location")!).searchParams.has("error"));
    assert.equal(refused.id, undefined);
  }
  const invalidCallback = await f.begin(first, { redirect_uri: "https://other.example/callback" });
  assert.equal(invalidCallback.response.status, 400);
  assert.equal(invalidCallback.response.headers.has("location"), false);
});

test("registration rejects insecure callbacks and unsupported grant types", async (t) => {
  const f = await fixture(t);
  for (const metadata of [
    { redirect_uris: ["javascript:alert(1)"] },
    { redirect_uris: ["http://remote.example/callback"] },
    { redirect_uris: ["https://user:password@client.example/callback"] },
    { redirect_uris: [callback], grant_types: ["client_credentials"] },
    { redirect_uris: [callback], scope: "offramp:pay" },
  ]) {
    const refused = await f.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_endpoint_auth_method: "none", ...metadata }),
    });
    assert.equal(refused.status, 400);
  }
});

test("refresh rotates tokens without escalating scope; revocation invalidates the connection", async (t) => {
  const f = await fixture(t);
  const grant = await f.grant();
  const fields = {
    client_id: grant.clientId,
    grant_type: "refresh_token",
    refresh_token: grant.refresh_token,
    resource,
  };
  assert.equal((await f.token({ ...fields, scope: "offramp:pay" })).status, 400);
  const response = await f.token(fields);
  assert.equal(response.status, 200);
  const refreshed = await response.json();
  assert.notEqual(refreshed.access_token, grant.access_token);
  assert.notEqual(refreshed.refresh_token, grant.refresh_token);
  assert.equal((await f.token(fields)).status, 400);
  const revoked = await f.request("/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: grant.clientId,
      token: refreshed.refresh_token,
      token_type_hint: "refresh_token",
    }),
  });
  assert.equal(revoked.status, 200);
  for (const token of [grant.access_token, refreshed.access_token]) {
    const denied = await f.request("/mcp", { headers: { Authorization: "Bearer " + token } });
    assert.equal(denied.status, 401);
  }
  assert.equal((await f.token({ ...fields, refresh_token: refreshed.refresh_token })).status, 400);
});

test("OAuth consent and access tokens expire, while a valid refresh can reconnect", async (t) => {
  let now = Date.now();
  const f = await fixture(t, () => now);
  const grant = await f.grant();
  const pending = await f.begin(grant.clientId);
  now += 16 * 60_000;
  assert.equal((await f.consent(pending)).status, 403);
  const denied = await f.request("/mcp", {
    headers: { Authorization: "Bearer " + grant.access_token },
  });
  assert.equal(denied.status, 401);
  const refreshed = await f.token({
    client_id: grant.clientId,
    grant_type: "refresh_token",
    refresh_token: grant.refresh_token,
    resource,
  });
  assert.equal(refreshed.status, 200);
  now += 61 * 60_000;
  const tokens = await refreshed.json();
  assert.equal(
    (
      await f.token({
        client_id: grant.clientId,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource,
      })
    ).status,
    400,
  );
});

test("two OAuth grants for the same client cannot read or delete each other's MCP session", async (t) => {
  const f = await fixture(t);
  const first = await f.grant();
  const second = await f.grant(first.clientId);
  const a = await f.connect(first.access_token);
  const b = await f.connect(second.access_token);
  const aReady = result(
    (await a.client.callTool({
      name: "get_connection_readiness",
      arguments: {},
    })) as CallToolResult,
  ).result!;
  const bReady = result(
    (await b.client.callTool({
      name: "get_connection_readiness",
      arguments: {},
    })) as CallToolResult,
  ).result!;
  assert.notEqual(aReady.connectionId, bReady.connectionId);
  for (const method of ["GET", "DELETE"]) {
    const denied = await f.request("/mcp", {
      method,
      headers: {
        Authorization: "Bearer " + second.access_token,
        "Mcp-Session-Id": a.transport.sessionId!,
      },
    });
    assert.equal(denied.status, 404);
  }
  assert.equal((await a.client.listTools()).tools.length, 2);
});

test("MCP session limits include parallel initializations and origin checks reject cross-site requests", async (t) => {
  const f = await fixture(t);
  const grant = await f.grant();
  const headers = {
    Authorization: "Bearer " + grant.access_token,
    "Content-Type": "application/json",
  };
  const refused = await f.request("/mcp", {
    headers: { ...headers, Origin: "https://other.example" },
  });
  assert.equal(refused.status, 403);
  // Node fetch normalizes Host to the URL authority; use an actual HTTP Host header.
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      f.base + "/health",
      { headers: { Host: "other.example" } },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
  assert.equal(hostStatus, 403);
  const responses = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      f.request("/mcp", {
        method: "POST",
        headers: { ...headers, Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: index,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "parallel-test", version: "1" },
          },
        }),
      }),
    ),
  );
  assert.equal(responses.filter((item) => item.status === 200).length, 4);
  assert.equal(responses.filter((item) => item.status === 429).length, 2);
  for (const item of responses) await item.text();
  const badJson = await f.request("/mcp", {
    method: "POST",
    headers,
    body: '{"private":"do-not-echo-this"',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.text()).includes("do-not-echo-this"), false);
});

test("clients without forms cannot substitute confirmed=true for a human response", async (t) => {
  const f = await fixture(t);
  const grant = await f.grant();
  const { client, prompts } = await f.connect(grant.access_token);
  assert.equal(
    result(
      (await client.callTool({ name: "test_human_approval", arguments: {} })) as CallToolResult,
    ).error?.code,
    "HUMAN_APPROVAL_UNAVAILABLE",
  );
  assert.equal(
    (
      await client.callTool({
        name: "test_human_approval",
        arguments: { confirmed: true },
      })
    ).isError,
    true,
  );
  assert.deepEqual(prompts, []);
});

for (const [label, answer, accepted] of [
  ["accept", { action: "accept", content: { approve: true } }, true],
  ["unchecked", { action: "accept", content: { approve: false } }, false],
  ["decline", { action: "decline" }, false],
  ["cancel", { action: "cancel" }, false],
] as const) {
  test(
    "HTTP human-form test observes " + label + " without granting payment authority",
    async (t) => {
      const f = await fixture(t);
      const grant = await f.grant();
      const { client, prompts } = await f.connect(grant.access_token, answer);
      const readiness = result(
        (await client.callTool({
          name: "get_connection_readiness",
          arguments: {},
        })) as CallToolResult,
      ).result!;
      assert.equal(readiness.formElicitationAdvertised, true);
      assert.equal(readiness.approvalUiVerified, false);
      const observed = result(
        (await client.callTool({ name: "test_human_approval", arguments: {} })) as CallToolResult,
      ).result!;
      assert.equal(prompts.length, 1);
      assert.equal(observed.action, answer.action);
      assert.equal(observed.testAccepted, accepted);
      assert.equal(observed.clientResponseObserved, true);
      assert.equal(observed.humanInteractionIndependentlyVerified, false);
      assert.equal(observed.paymentExecutionAvailable, false);
      assert.equal(observed.walletConnected, false);
    },
  );
}

test("web CLI rejects invalid deployment configuration without reading or creating a wallet profile", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "offramp-web-profile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profile = join(directory, "must-not-be-created");
  await assert.rejects(
    promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli.ts", "web-probe"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OFFRAMP_WEB_PROBE_URL: "http://remote.example",
        OFFRAMP_DATA_DIR: profile,
        OFFRAMP_MODE: "invalid-to-detect-profile-reads",
        CIRCLE_BIN: "must-not-be-invoked",
      },
    }),
    (error: unknown) => {
      const stderr = (error as { stderr: string }).stderr;
      assert.ok(stderr.includes("HTTPS origin or loopback HTTP"));
      assert.equal(stderr.includes("OFFRAMP_MODE"), false);
      return true;
    },
  );
  assert.equal(existsSync(profile), false);
  for (const url of [
    "http://remote.example",
    "https://example.com/path",
    "https://user:secret@example.com",
    "https://example.com?token=secret",
    "https://example.com#fragment",
  ])
    assert.throws(() => webProbeOrigin(url));
});
