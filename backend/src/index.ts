import { z } from "zod";
import { OfframpError, publicError } from "../../src/errors.js";
import { base64url, requestMessage, sha256, unbase64url } from "../../src/hosted-protocol.js";
import { jsonRequest, readLimitedText } from "../../src/http.js";
import { units } from "../../src/money.js";
import {
  PajClient,
  PAJ_USDC,
  providerAmount,
  type JsonRequest,
  type PajOrder,
} from "../../src/providers/paj.js";

class ApiError extends OfframpError {
  constructor(
    code: string,
    message: string,
    readonly status: number,
  ) {
    super(code, message);
  }
}
function fail(
  condition: unknown,
  code: string,
  message: string,
  status: number,
): asserts condition {
  if (!condition) throw new ApiError(code, message, status);
}
const bankInput = z
  .object({
    bankCode: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    accountNumber: z.string().regex(/^\d{10}$/),
  })
  .strict();
const orderInput = bankInput
  .extend({
    requestId: z.string().uuid(),
    currency: z.literal("NGN"),
    chain: z.literal("ARC"),
    mint: z.literal(PAJ_USDC.ARC),
    amount: z.number().finite().positive().optional(),
    fiatAmount: z.number().finite().positive().optional(),
  })
  .strict()
  .refine((value) => (value.amount === undefined) !== (value.fiatAmount === undefined));

function limit(value: string): number {
  const number = Number(value);
  fail(
    Number.isSafeInteger(number) && number > 0 && number <= 100_000,
    "SERVICE_UNAVAILABLE",
    "The service limits are not configured.",
    503,
  );
  return number;
}

function rawOrder(order: PajOrder) {
  return {
    id: order.id,
    address: order.depositAddress,
    mint: order.mint,
    currency: order.currency,
    amount: order.usdc,
    fiatAmount: order.ngn,
    chain: order.chain,
    status: order.status,
    transactionType: order.transactionType,
    fee: order.providerFeeUsdc,
    createdAt: order.createdAt,
    ...(order.signature ? { signature: order.signature } : {}),
    ...(order.sender ? { sender: order.sender } : {}),
    ...(order.recipient ? { recipient: order.recipient } : {}),
  };
}

async function authenticate(request: Request, body: string, now: number) {
  try {
    const keyText = request.headers.get("x-offramp-key") ?? "";
    const timestamp = request.headers.get("x-offramp-time") ?? "";
    const nonce = request.headers.get("x-offramp-nonce") ?? "";
    const signature = unbase64url(request.headers.get("x-offramp-signature") ?? "");
    const encodedKey = unbase64url(keyText);
    if (
      encodedKey.length !== 44 ||
      signature.length !== 64 ||
      !/^\d{13}$/.test(timestamp) ||
      Math.abs(now - Number(timestamp)) > 60_000 ||
      !/^[a-f0-9-]{36}$/.test(nonce)
    )
      throw new Error("Invalid authentication");
    const key = await crypto.subtle.importKey("spki", encodedKey, "Ed25519", false, ["verify"]);
    const message = await requestMessage(request.method, request.url, timestamp, nonce, body);
    if (!(await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(message))))
      throw new Error("Invalid signature");
    return { owner: await sha256(encodedKey), nonce };
  } catch {
    throw new ApiError(
      "SERVICE_AUTH_REQUIRED",
      "The service connection could not be authenticated. Check the local identity and system clock.",
      401,
    );
  }
}

async function charge(
  env: Env,
  buckets: { key: string; window: number; limit: number; expires: number }[],
) {
  const results = await env.DB.batch(
    buckets.map((bucket) =>
      env.DB.prepare(
        "INSERT INTO quotas(bucket,window,used,expires_at) VALUES(?,?,1,?) ON CONFLICT(bucket,window) DO UPDATE SET used=used+1 WHERE used<? RETURNING used",
      ).bind(bucket.key, bucket.window, bucket.expires, bucket.limit),
    ),
  );
  fail(
    results.every((result) => result.results.length === 1),
    "SERVICE_RATE_LIMIT",
    "The service request allowance has been reached. Please try again later.",
    429,
  );
}

async function quotas(request: Request, env: Env, owner: string, now: number) {
  const ip = request.headers.get("cf-connecting-ip");
  fail(
    ip && ip.length <= 64 && env.IP_HASH_SECRET?.length >= 24,
    "SERVICE_UNAVAILABLE",
    "The service connection is not configured.",
    503,
  );
  const secret = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.IP_HASH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const ipId = base64url(
    new Uint8Array(await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(ip))),
  );
  const minute = Math.floor(now / 60_000);
  const day = Math.floor(now / 86_400_000);
  await charge(env, [
    {
      key: "requests:global",
      window: day,
      limit: limit(env.REQUESTS_PER_DAY),
      expires: (day + 1) * 86_400_000,
    },
    {
      key: `requests:ip:${ipId}`,
      window: minute,
      limit: limit(env.REQUESTS_PER_IP_MINUTE),
      expires: (minute + 1) * 60_000,
    },
    {
      key: `requests:owner:${owner}`,
      window: minute,
      limit: limit(env.REQUESTS_PER_MINUTE),
      expires: (minute + 1) * 60_000,
    },
  ]);
  return { ipId, day };
}

interface SavedOrder {
  request_hash: string;
  state: "creating" | "created" | "uncertain";
  provider_id: string | null;
}

async function createOrder(
  body: unknown,
  env: Env,
  provider: PajClient,
  owner: string,
  ipId: string,
  day: number,
  now: number,
) {
  const input = orderInput.parse(body);
  const usdc = input.amount === undefined ? undefined : providerAmount(input.amount);
  const ngn = input.fiatAmount === undefined ? undefined : providerAmount(input.fiatAmount, 2);
  fail(
    (usdc === undefined || units(usdc) <= units(env.MAX_ORDER_USDC)) &&
      (ngn === undefined || units(ngn, 2) <= units(env.MAX_ORDER_NGN, 2)),
    "PAYOUT_LIMIT",
    "The requested amount exceeds the hosted service limit.",
    400,
  );
  const data = {
    bankCode: input.bankCode,
    accountNumber: input.accountNumber,
    ...(usdc ? { usdc } : {}),
    ...(ngn ? { receiveNgn: ngn } : {}),
  };
  const hash = await sha256(JSON.stringify(data));
  const existing = await env.DB.prepare(
    "SELECT request_hash,state,provider_id FROM orders WHERE owner=? AND request_id=?",
  )
    .bind(owner, input.requestId)
    .first<SavedOrder>();
  const inspectExisting = async (row: SavedOrder) => {
    fail(
      row.request_hash === hash,
      "REQUEST_CONFLICT",
      "This request ID was already used for different payment terms.",
      409,
    );
    fail(
      row.state === "created" && row.provider_id,
      "ORDER_PREPARATION_UNCERTAIN",
      "An order request is pending or uncertain. Do not automatically create a replacement.",
      409,
    );
    return rawOrder(await provider.transaction(row.provider_id));
  };
  if (existing) return inspectExisting(existing);
  const expires = (day + 1) * 86_400_000;
  await charge(env, [
    { key: "orders:global", window: day, limit: limit(env.ORDERS_PER_DAY), expires },
    {
      key: `orders:owner:${owner}`,
      window: day,
      limit: limit(env.ORDERS_PER_INSTALLATION_DAY),
      expires,
    },
    { key: `orders:ip:${ipId}`, window: day, limit: limit(env.ORDERS_PER_IP_DAY), expires },
  ]);
  const claimed = await env.DB.prepare(
    "INSERT INTO orders(owner,request_id,request_hash,state,created_at,updated_at) VALUES(?,?,?,'creating',?,?) ON CONFLICT(owner,request_id) DO NOTHING RETURNING request_id",
  )
    .bind(owner, input.requestId, hash, now, now)
    .first();
  if (!claimed) {
    const current = await env.DB.prepare(
      "SELECT request_hash,state,provider_id FROM orders WHERE owner=? AND request_id=?",
    )
      .bind(owner, input.requestId)
      .first<SavedOrder>();
    fail(current, "ORDER_PREPARATION_UNCERTAIN", "The order request could not be reconciled.", 409);
    return inspectExisting(current);
  }
  try {
    const order = await provider.createOfframp(data);
    fail(
      units(order.usdc) <= units(env.MAX_ORDER_USDC) &&
        units(order.ngn, 2) <= units(env.MAX_ORDER_NGN, 2),
      "PAYOUT_LIMIT",
      "The quoted amount exceeds the hosted service limit.",
      400,
    );
    const raw = rawOrder(order);
    const saved = await env.DB.prepare(
      "UPDATE orders SET state='created',provider_id=?,response=?,updated_at=? WHERE owner=? AND request_id=? AND state='creating'",
    )
      .bind(order.id, JSON.stringify(raw), now, owner, input.requestId)
      .run();
    fail(
      saved.meta.changes === 1,
      "ORDER_PREPARATION_UNCERTAIN",
      "The created order could not be recorded. Do not automatically retry.",
      503,
    );
    return raw;
  } catch {
    await env.DB.prepare(
      "UPDATE orders SET state='uncertain',updated_at=? WHERE owner=? AND request_id=? AND state='creating'",
    )
      .bind(now, owner, input.requestId)
      .run();
    throw new ApiError(
      "ORDER_PREPARATION_UNCERTAIN",
      "The order request did not complete reliably. No funding was sent. Do not automatically create a replacement.",
      503,
    );
  }
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      ...(status === 429 ? { "retry-after": "60" } : {}),
    },
  });
}

export function createBackend(upstream: JsonRequest = jsonRequest) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health" && !url.search)
          return json({ service: "naira-offramp-api", protocol: 1, chain: "ARC" });
        fail(
          env.PAJ_API_KEY?.length > 0 && env.IP_HASH_SECRET?.length >= 24,
          "SERVICE_UNAVAILABLE",
          "The hosted service is not configured.",
          503,
        );
        fail(
          request.method === "GET" || request.method === "POST",
          "METHOD_NOT_ALLOWED",
          "Use a supported API method.",
          405,
        );
        const body = await readLimitedText(request, 4096);
        fail(
          request.method !== "GET" || !body,
          "INVALID_REQUEST",
          "GET requests cannot contain a body.",
          400,
        );
        if (request.method === "POST")
          fail(
            request.headers.get("content-type")?.split(";")[0] === "application/json",
            "INVALID_REQUEST",
            "Use a JSON request.",
            400,
          );
        const now = Date.now();
        const { owner, nonce } = await authenticate(request, body, now);
        const claimed = await env.DB.prepare(
          "INSERT INTO request_nonces(owner,nonce,expires_at) VALUES(?,?,?) ON CONFLICT(owner,nonce) DO NOTHING RETURNING nonce",
        )
          .bind(owner, nonce, now + 120_000)
          .first();
        fail(claimed, "REQUEST_REPLAY", "This signed request has already been used.", 409);
        const { ipId, day } = await quotas(request, env, owner, now);
        const provider = new PajClient("production", env.PAJ_API_KEY, upstream);
        if (
          request.method === "GET" &&
          url.pathname === "/v1/rate" &&
          url.search === "?currency=NGN"
        ) {
          const rate = await provider.rate();
          return json({
            offRampRate: {
              baseCurrency: "USD",
              targetCurrency: "NGN",
              type: "offRamp",
              rate: rate.ngnPerUsdc,
              ...(rate.providerUpdatedAt ? { createdAt: rate.providerUpdatedAt } : {}),
            },
          });
        }
        if (request.method === "GET" && url.pathname === "/v1/chains" && !url.search)
          return json(await provider.chains());
        if (request.method === "GET" && url.pathname === "/v1/bank" && url.search === "?country=NG")
          return json(await provider.banks());
        if (request.method === "POST" && url.pathname === "/v1/bank-account" && !url.search) {
          const input = bankInput.parse(JSON.parse(body));
          const bank = await provider.resolveBank(input.bankCode, input.accountNumber);
          return json({
            accountNumber: bank.accountNumber,
            accountName: bank.accountName,
            bank: bank.bankName,
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/offramp" && !url.search)
          return json(
            await createOrder(JSON.parse(body), env, provider, owner, ipId, day, now),
            201,
          );
        const id = /^\/v1\/transaction\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname)?.[1];
        if (request.method === "GET" && id && !url.search) {
          const owned = await env.DB.prepare(
            "SELECT provider_id FROM orders WHERE owner=? AND provider_id=? AND state='created'",
          )
            .bind(owner, id)
            .first();
          fail(owned, "ORDER_NOT_FOUND", "No order with that ID exists for this connection.", 404);
          return json(rawOrder(await provider.transaction(id)));
        }
        throw new ApiError("NOT_FOUND", "No supported API route exists at this address.", 404);
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          return json(
            {
              error: {
                code: "INVALID_REQUEST",
                message: "The request does not match the supported Arc payout format.",
              },
            },
            400,
          );
        if (!(error instanceof OfframpError))
          console.error(JSON.stringify({ event: "backend_failure", code: "INTERNAL_ERROR" }));
        const status =
          error instanceof ApiError
            ? error.status
            : error instanceof OfframpError
              ? error.code === "RESPONSE_TOO_LARGE"
                ? 413
                : 502
              : 503;
        return json({ error: publicError(error) }, status);
      }
    },
    async scheduled(_event: ScheduledController, env: Env): Promise<void> {
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM request_nonces WHERE expires_at<?").bind(now),
        env.DB.prepare("DELETE FROM quotas WHERE expires_at<?").bind(now),
      ]);
    },
  } satisfies ExportedHandler<Env>;
}

export default createBackend();
