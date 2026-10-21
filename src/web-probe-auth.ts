import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  TemporarilyUnavailableError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { consentPage, messagePage, sendPage } from "./web-probe-page.js";

export const PROBE_SCOPE = "offramp:probe";
export const PROBE_SCOPES = [PROBE_SCOPE, "offline_access"];
const CONSENT_COOKIE = "offramp_probe_consent";
const secret = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest();

class ExpiringStore<T extends { expiresAtMs: number }> {
  private readonly values = new Map<string, T>();
  constructor(
    private readonly maximum: number,
    private readonly now: () => number,
  ) {}
  prune() {
    for (const [key, value] of this.values)
      if (value.expiresAtMs <= this.now()) this.values.delete(key);
  }
  get(key: string) {
    this.prune();
    return this.values.get(key);
  }
  set(key: string, value: T) {
    this.prune();
    if (this.values.size >= this.maximum)
      throw new TemporarilyUnavailableError("The connection test is at capacity. Try again later.");
    this.values.set(key, value);
  }
  delete(key: string) {
    this.values.delete(key);
  }
  deleteConnection(connectionId: string) {
    for (const [key, value] of this.values)
      if ("connectionId" in value && value.connectionId === connectionId) this.values.delete(key);
  }
}

type Consent = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  cookieDigest: Buffer;
  expiresAtMs: number;
};
type Grant = {
  clientId: string;
  connectionId: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  expiresAtMs: number;
};
type Token = {
  clientId: string;
  connectionId: string;
  scopes: string[];
  expiresAtMs: number;
};

/**
 * OAuth authorization for public, harmless compatibility tools only.
 * A grant identifies an isolated test connection, NOT a person or Circle wallet.
 * This in-memory provider must never be reused to authorize real payouts.
 */
export class ProbeAuthorization implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly clients: ExpiringStore<{
    client: OAuthClientInformationFull;
    expiresAtMs: number;
  }>;
  private readonly consents: ExpiringStore<Consent>;
  private readonly codes: ExpiringStore<Grant>;
  private readonly access: ExpiringStore<Token>;
  private readonly refresh: ExpiringStore<Token>;

  constructor(
    readonly origin: URL,
    readonly resource: URL,
    private readonly now: () => number = Date.now,
  ) {
    this.clients = new ExpiringStore(128, now);
    this.consents = new ExpiringStore(128, now);
    this.codes = new ExpiringStore(128, now);
    this.access = new ExpiringStore(512, now);
    this.refresh = new ExpiringStore(512, now);
    this.clientsStore = {
      getClient: (id) => this.clients.get(id)?.client,
      registerClient: (input) => {
        if (
          input.redirect_uris.length < 1 ||
          input.redirect_uris.length > 8 ||
          input.redirect_uris.some((uri) => !safeRedirect(uri)) ||
          !["none", "client_secret_post"].includes(
            input.token_endpoint_auth_method ?? "client_secret_post",
          ) ||
          input.grant_types?.some(
            (grant) => !["authorization_code", "refresh_token"].includes(grant),
          ) ||
          input.response_types?.some((response) => response !== "code") ||
          (input.client_name?.length ?? 0) > 120 ||
          (input.scope && input.scope.split(" ").some((scope) => !PROBE_SCOPES.includes(scope)))
        )
          throw new InvalidClientMetadataError("Unsupported connection-test client metadata.");
        const client = {
          ...input,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(now() / 1000),
        };
        this.clients.set(client.client_id, { client, expiresAtMs: now() + 24 * 60 * 60_000 });
        return client;
      },
    };
  }

  private checkResource(resource?: URL) {
    if (resource && resource.href !== this.resource.href)
      throw new InvalidTargetError("This grant is only for the connection-test endpoint.");
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Parameters<OAuthServerProvider["authorize"]>[2],
  ) {
    this.checkResource(params.resource);
    const scopes = params.scopes?.length ? params.scopes : [PROBE_SCOPE];
    if (!scopes.includes(PROBE_SCOPE) || scopes.some((scope) => !PROBE_SCOPES.includes(scope)))
      throw new InvalidScopeError("Only connection-test permissions are available.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 512)
      throw new InvalidGrantError("Invalid connection-test authorization request.");
    const id = secret();
    const binding = secret();
    this.consents.set(id, {
      client,
      params: { ...params, scopes: [...new Set(scopes)] },
      cookieDigest: digest(binding),
      expiresAtMs: this.now() + 5 * 60_000,
    });
    res.setHeader("Set-Cookie", this.cookie(binding, 300));
    sendPage(
      res,
      200,
      consentPage(id, client.client_name ?? "MCP client", new URL(params.redirectUri).origin),
    );
  }

  private cookie(value: string, maxAge: number) {
    return (
      CONSENT_COOKIE +
      "=" +
      value +
      "; Path=/consent; HttpOnly; SameSite=Lax; Max-Age=" +
      maxAge +
      (this.origin.protocol === "https:" ? "; Secure" : "")
    );
  }

  async consent(req: IncomingMessage, res: ServerResponse) {
    if (
      req.headers.origin !== this.origin.origin ||
      req.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded"
    ) {
      sendPage(
        res,
        403,
        messagePage("Connection refused", "Return to your chat and connect again."),
      );
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 4096) {
        sendPage(
          res,
          413,
          messagePage("Request too large", "Return to your chat and connect again."),
        );
        return;
      }
    }
    const form = new URLSearchParams(body);
    const id = form.get("request") ?? "";
    const pending = this.consents.get(id);
    const cookie = req.headers.cookie
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(CONSENT_COOKIE + "="))
      ?.slice(CONSENT_COOKIE.length + 1);
    if (
      !pending ||
      !cookie ||
      !timingSafeEqual(digest(cookie), pending.cookieDigest) ||
      form.getAll("request").length !== 1 ||
      form.getAll("decision").length !== 1 ||
      !["allow", "deny"].includes(form.get("decision") ?? "")
    ) {
      sendPage(
        res,
        403,
        messagePage("Connection expired", "Return to your chat and start a new connection."),
      );
      return;
    }
    this.consents.delete(id);
    res.setHeader("Set-Cookie", this.cookie("", 0));
    const redirect = new URL(pending.params.redirectUri);
    if (pending.params.state !== undefined)
      redirect.searchParams.set("state", pending.params.state);
    if (form.get("decision") === "deny") {
      redirect.searchParams.set("error", "access_denied");
    } else {
      const code = secret();
      this.codes.set(code, {
        clientId: pending.client.client_id,
        connectionId: randomUUID(),
        redirectUri: pending.params.redirectUri,
        challenge: pending.params.codeChallenge,
        scopes: pending.params.scopes!,
        expiresAtMs: this.now() + 60_000,
      });
      redirect.searchParams.set("code", code);
    }
    res.writeHead(303, { Location: redirect.href });
    res.end();
  }

  private grant(client: OAuthClientInformationFull, code: string) {
    const grant = this.codes.get(code);
    if (!grant || grant.clientId !== client.client_id)
      throw new InvalidGrantError("The authorization code is invalid or expired.");
    return grant;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    return this.grant(client, code).challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    this.checkResource(resource);
    const grant = this.grant(client, code);
    if (redirectUri !== grant.redirectUri)
      throw new InvalidGrantError("The callback must match the original authorization request.");
    this.codes.delete(code);
    return this.issue(grant, true);
  }

  private issue(grant: Token, allowRefresh: boolean): OAuthTokens {
    const accessToken = secret();
    this.access.set(accessToken, { ...grant, expiresAtMs: this.now() + 15 * 60_000 });
    const response: OAuthTokens = {
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: 900,
      scope: grant.scopes.join(" "),
    };
    if (allowRefresh && grant.scopes.includes("offline_access")) {
      const refreshToken = secret();
      this.refresh.set(refreshToken, { ...grant, expiresAtMs: this.now() + 60 * 60_000 });
      response.refresh_token = refreshToken;
    }
    return response;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ) {
    this.checkResource(resource);
    const grant = this.refresh.get(refreshToken);
    if (!grant || grant.clientId !== client.client_id)
      throw new InvalidGrantError("The refresh token is invalid or expired.");
    if (scopes?.some((scope) => !grant.scopes.includes(scope)))
      throw new InvalidScopeError("A refresh cannot add permissions.");
    if (scopes && !scopes.includes(PROBE_SCOPE))
      throw new InvalidScopeError("The connection-test permission is required.");
    this.refresh.delete(refreshToken);
    return this.issue({ ...grant, scopes: scopes ?? grant.scopes }, true);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const grant = this.access.get(token);
    if (!grant) throw new InvalidTokenError("The connection token is invalid or expired.");
    return {
      token,
      clientId: grant.clientId,
      scopes: [...grant.scopes],
      expiresAt: Math.floor(grant.expiresAtMs / 1000),
      resource: new URL(this.resource),
      extra: { connectionId: grant.connectionId },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const grant = this.access.get(request.token) ?? this.refresh.get(request.token);
    if (grant?.clientId !== client.client_id) return;
    this.access.deleteConnection(grant.connectionId);
    this.refresh.deleteConnection(grant.connectionId);
  }
}

function safeRedirect(value: string) {
  try {
    const uri = new URL(value);
    return (
      value.length <= 2048 &&
      !uri.username &&
      !uri.password &&
      !uri.hash &&
      (uri.protocol === "https:" ||
        (uri.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname)))
    );
  } catch {
    return false;
  }
}
