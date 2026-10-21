import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isInitializeRequest, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { packageInfo } from "./package-info.js";
import {
  PROBE_SCOPE,
  PROBE_SCOPES,
  ProbeAuthorization,
  type ProbeConsentEvent,
} from "./web-probe-auth.js";
import { landingPage, pageHeaders, sendPage } from "./web-probe-page.js";
import { requireThat } from "./errors.js";

const SESSION_IDLE_MS = 15 * 60_000;
const MAXIMUM_SESSIONS = 64;
const MAXIMUM_CONNECTION_SESSIONS = 4;
const MAXIMUM_CONNECTION_REQUESTS = 120;

function toolResult(result: Record<string, unknown>, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

export function createWebProbeMcpServer(connectionId: string) {
  const server = new McpServer(
    { name: "naira-offramp-web-probe", version: packageInfo.version },
    {
      instructions:
        "Compatibility test only. This server has no wallet or payment tools. Check connection readiness, then ask the human whether to try test_human_approval. Never request API keys, OTPs or wallet credentials. A successful approval test grants no payment authority. Report advertised capabilities separately from an observed human response. Do not infer the client's subscription plan or mobile support.",
      maxToolInputElements: 4,
    },
  );
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  };
  server.registerTool(
    "get_connection_readiness",
    {
      title: "Check web connection",
      description:
        "Read this connection's reported client name and human-form capability. Does not contact Circle or PAJ. No wallet is connected and payments are unavailable.",
      inputSchema: z.object({}).strict(),
      annotations: { ...annotations, idempotentHint: true },
    },
    () =>
      toolResult({
        result: {
          stage: "compatibility_probe",
          connectionId,
          client: server.server.getClientVersion() ?? null,
          formElicitationAdvertised: Boolean(
            server.server.getClientCapabilities()?.elicitation?.form,
          ),
          approvalUiVerified: false,
          walletConnected: false,
          paymentExecutionAvailable: false,
        },
      }),
  );
  server.registerTool(
    "test_human_approval",
    {
      title: "Try a harmless approval",
      description:
        "Ask the human to try an approval form for compatibility testing. It cannot connect a wallet, create an order or send money. Accepting is never payment approval. Tool arguments cannot approve this test.",
      inputSchema: z.object({}).strict(),
      annotations: { ...annotations, idempotentHint: false },
    },
    async () => {
      if (!server.server.getClientCapabilities()?.elicitation?.form)
        return toolResult(
          {
            error: {
              code: "HUMAN_APPROVAL_UNAVAILABLE",
              message:
                "This connection does not advertise MCP form elicitation. Payment execution remains unavailable.",
            },
          },
          true,
        );
      try {
        const response = await server.server.elicitInput(
          {
            mode: "form",
            message:
              "Naira Offramp connection test only. No wallet is connected and no money will move. Accept or decline to test whether your chat app shows this form. This response will never approve a payment.",
            requestedSchema: {
              type: "object",
              properties: {
                approve: {
                  type: "boolean",
                  title: "I approve this harmless connection test",
                  default: false,
                },
              },
              required: ["approve"],
            },
          },
          { timeout: 60_000 },
        );
        return toolResult({
          result: {
            action: response.action,
            testAccepted: response.action === "accept" && response.content?.approve === true,
            clientResponseObserved: true,
            humanInteractionIndependentlyVerified: false,
            walletConnected: false,
            paymentExecutionAvailable: false,
          },
        });
      } catch {
        return toolResult(
          {
            error: {
              code: "APPROVAL_TEST_INCOMPLETE",
              message:
                "The approval test did not finish. No payment was prepared or sent. The human should confirm whether a form appeared.",
            },
          },
          true,
        );
      }
    },
  );
  return server;
}

export function webProbeOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The web probe public URL must be an HTTPS origin or loopback HTTP origin.");
  }
  requireThat(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))),
    "INVALID_CONFIG",
    "The web probe public URL must be an HTTPS origin or loopback HTTP origin.",
  );
  return new URL(url.origin);
}

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  owner: string;
  lastActivity: number;
};

/**
 * Completely separate from createRuntime(), private profiles and CircleAgent.
 * Only synthetic connection permissions are stored, in bounded in-memory maps.
 */
export function createWebProbeServer(options: {
  publicUrl: string;
  allowedOrigins?: string[];
  now?: () => number;
  onConsentEvent?: (event: ProbeConsentEvent) => void;
  onOAuthResponse?: (event: {
    event: "probe_oauth_response";
    path: string;
    method: string;
    status: number;
  }) => void;
}) {
  const origin = webProbeOrigin(options.publicUrl);
  const resource = new URL("/mcp", origin);
  const allowedOrigins = new Set([
    origin.origin,
    ...(options.allowedOrigins ?? []).map((value) => webProbeOrigin(value).origin),
  ]);
  const provider = new ProbeAuthorization(origin, resource, options.now, options.onConsentEvent);
  const app = createMcpExpressApp({
    allowedHosts: [origin.hostname, "127.0.0.1", "localhost", "[::1]"],
  });
  app.disable("x-powered-by");
  const sessions = new Map<string, Session>();
  const starting = new Map<string, number>();
  let startingTotal = 0;
  const usage = new Map<string, { count: number; until: number }>();
  app.use((req, res, next) => {
    pageHeaders(res);
    if (["/authorize", "/consent", "/token", "/register"].includes(req.path)) {
      // Only fixed route names and response codes: never query strings, request
      // bodies, headers or callback URLs, which can contain OAuth credentials.
      const path = req.path;
      res.once("finish", () =>
        options.onOAuthResponse?.({
          event: "probe_oauth_response",
          path,
          method: req.method,
          status: res.statusCode,
        }),
      );
    }
    const requestOrigin = req.headers.origin;
    if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
      res.status(403).json({ error: "ORIGIN_NOT_ALLOWED" });
      return;
    }
    if (requestOrigin) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
      );
      res.status(204).end();
      return;
    }
    next();
  });
  app.get("/", (_req, res) => sendPage(res, 200, landingPage(resource.href)));
  app.get("/health", (_req, res) =>
    res.json({
      service: "naira-offramp-web-probe",
      paymentsEnabled: false,
      walletConnected: false,
    }),
  );
  app.post("/consent", (req, res) => {
    void provider.consent(req, res).catch(() => {
      if (!res.headersSent) res.status(400).json({ error: "INVALID_CONSENT_REQUEST" });
      else res.end();
    });
  });
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: origin,
      resourceServerUrl: resource,
      resourceName: "Naira Offramp connection test",
      scopesSupported: PROBE_SCOPES,
      serviceDocumentationUrl: new URL(
        "https://github.com/Adeyemir/naira-offramp-mcp/blob/feat/web-mobile-mcp/docs/web-connector.md",
      ),
    }),
  );
  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [PROBE_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    expectedResource: resource,
  });
  app.all("/mcp", bearer, async (req, res) => {
    let fresh: Session | undefined;
    let reservation: string | undefined;
    try {
      const connectionId = req.auth?.extra?.connectionId;
      if (typeof connectionId !== "string") {
        res.status(401).json({ error: "INVALID_CONNECTION" });
        return;
      }
      const now = Date.now();
      const existingUsage = usage.get(connectionId);
      if (existingUsage && existingUsage.until > now) {
        if (++existingUsage.count > MAXIMUM_CONNECTION_REQUESTS) {
          res.setHeader("Retry-After", String(Math.ceil((existingUsage.until - now) / 1000)));
          res.status(429).json({ error: "RATE_LIMITED" });
          return;
        }
      } else {
        // Expired access tokens cannot reach this middleware; prune old counters.
        for (const [id, value] of usage) if (value.until <= now) usage.delete(id);
        if (usage.size >= 512) {
          res.status(503).json({ error: "PROBE_AT_CAPACITY" });
          return;
        }
        usage.set(connectionId, { count: 1, until: now + 60_000 });
      }
      if (!["POST", "GET", "DELETE"].includes(req.method)) {
        res.setHeader("Allow", "GET, POST, DELETE");
        res.status(405).end();
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      let session: Session;
      if (sessionId !== undefined) {
        const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
        if (!existing || existing.owner !== connectionId) {
          res.status(404).json({ error: "SESSION_NOT_FOUND" });
          return;
        }
        session = existing;
      } else {
        if (req.method !== "POST" || !isInitializeRequest(req.body)) {
          res.status(400).json({ error: "INITIALIZE_REQUIRED" });
          return;
        }
        const owned = [...sessions.values()].filter((item) => item.owner === connectionId).length;
        if (
          sessions.size + startingTotal >= MAXIMUM_SESSIONS ||
          owned + (starting.get(connectionId) ?? 0) >= MAXIMUM_CONNECTION_SESSIONS
        ) {
          res.status(429).json({ error: "SESSION_LIMIT" });
          return;
        }
        startingTotal++;
        starting.set(connectionId, (starting.get(connectionId) ?? 0) + 1);
        reservation = connectionId;
        const server = createWebProbeMcpServer(connectionId);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => {
            sessions.set(id, session);
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
            void server.close();
          },
        });
        session = { server, transport, owner: connectionId, lastActivity: now };
        fresh = session;
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        // SDK 1.x's HTTP accessor declarations explicitly include undefined;
        // its Transport interface uses optional properties under exact optional types.
        await server.connect(transport as Transport);
      }
      session.lastActivity = now;
      await session.transport.handleRequest(req, res, req.body);
      if (fresh && !fresh.transport.sessionId) await fresh.server.close();
    } catch {
      if (fresh) await fresh.server.close().catch(() => {});
      if (!res.headersSent) res.status(500).json({ error: "PROBE_REQUEST_FAILED" });
      else res.end();
    } finally {
      if (reservation) {
        startingTotal--;
        const count = (starting.get(reservation) ?? 1) - 1;
        if (count) starting.set(reservation, count);
        else starting.delete(reservation);
      }
    }
  });
  // Do not let body-parser's default error handler log request content or stack traces.
  app.use(
    (
      _error: unknown,
      _req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
      _next: (error?: unknown) => void,
    ) => {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "INVALID_REQUEST" }));
      } else res.end();
    },
  );
  const http = createServer(app);
  http.requestTimeout = 30_000;
  http.headersTimeout = 10_000;
  const timer = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastActivity < cutoff) {
        sessions.delete(id);
        void session.server.close().catch(() => {});
      }
    }
  }, 30_000).unref();
  return {
    http,
    endpoint: resource.href,
    async close() {
      clearInterval(timer);
      await Promise.allSettled([...sessions.values()].map((session) => session.server.close()));
      sessions.clear();
      const closed = new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections();
      await closed;
    },
  };
}

export async function startWebProbe() {
  const port = Number(process.env.OFFRAMP_WEB_PROBE_PORT ?? "8788");
  const host = process.env.OFFRAMP_WEB_PROBE_HOST ?? "127.0.0.1";
  requireThat(
    Number.isInteger(port) && port >= 1 && port <= 65535,
    "INVALID_CONFIG",
    "OFFRAMP_WEB_PROBE_PORT must be an integer from 1 to 65535.",
  );
  requireThat(
    ["127.0.0.1", "0.0.0.0"].includes(host),
    "INVALID_CONFIG",
    "OFFRAMP_WEB_PROBE_HOST must be 127.0.0.1 or 0.0.0.0.",
  );
  const probe = createWebProbeServer({
    publicUrl: process.env.OFFRAMP_WEB_PROBE_URL ?? "http://127.0.0.1:" + port,
    allowedOrigins: process.env.OFFRAMP_WEB_PROBE_ALLOWED_ORIGINS?.split(",").filter(Boolean) ?? [],
    onConsentEvent: (event) => console.error(JSON.stringify(event)),
    onOAuthResponse: (event) => console.error(JSON.stringify(event)),
  });
  await new Promise<void>((resolve, reject) => {
    probe.http.once("error", reject);
    probe.http.listen(port, host, resolve);
  });
  console.error(
    JSON.stringify({
      service: "naira-offramp-web-probe",
      endpoint: probe.endpoint,
      walletConnected: false,
      paymentsEnabled: false,
    }),
  );
  const shutdown = () => {
    void probe.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
