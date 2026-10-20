# Hosted payout API

Public API origin: `https://naira-offramp-api.adeyemir215.workers.dev`.

The Cloudflare Worker holds the operator's PAJ Business API key. The npm MCP client sends signed requests for bank lookup, recipient verification, unfunded Arc orders and payout status. The user's Circle CLI sends USDC directly to PAJ after local human approval. The backend does not hold user funds or receive wallet credentials.

## Connection and isolation

Each installation generates an Ed25519 connection identity in its private profile. There is no PAJ signup or manually entered app API key. Requests sign the method, origin, path/query, timestamp, unique nonce and body digest. The Worker checks the signature, allows 60 seconds of clock skew, claims each nonce once in D1 and applies request limits.

This is installation authentication, not verified human identity or proof of wallet ownership. Possession of the private connection key grants access to that installation's hosted orders. The local Circle CLI separately authenticates wallet ownership. Preserve `service-identity.json` with local payout history when backing up a profile.

Only an installation's own recorded order IDs can reach PAJ's transaction endpoint. The API exposes fixed routes and validates their inputs; it cannot forward arbitrary PAJ requests, webhook changes, tokens or chains.

## Deploy your own service

Use the source checkout and install dependencies with `npm ci`. The tools and generated binding types are pinned in the lockfile.

1. Authenticate with `npx wrangler login`.
2. Create a D1 database with `npx wrangler d1 create YOUR_DATABASE`.
3. Replace the database name and ID in `backend/wrangler.jsonc` with your resource. Choose a Worker name in your own account.
4. Apply `npx wrangler d1 migrations apply YOUR_DATABASE --remote --config backend/wrangler.jsonc`.
5. Run `npm run backend:check` and `npm run backend:test`.
6. Prepare a private JSON or dotenv secrets file outside the checkout containing `PAJ_API_KEY` and a random `IP_HASH_SECRET` of at least 24 characters. Protect it with mode `0600`.
7. Deploy with `npx wrangler deploy --config backend/wrangler.jsonc --secrets-file /absolute/path/to/private/secrets.json`. Wrangler requires these named secrets on the first deployment. Subsequent secret updates can use `npx wrangler secret put SECRET_NAME --config backend/wrangler.jsonc` and its private prompt. Keep the IP hash secret stable across deployments. Never add values to the config, client package or logs.
8. Set `OFFRAMP_BACKEND_URL` in your clients to the HTTPS origin reported by the deployment.

Before the secrets exist, API requests return `SERVICE_UNAVAILABLE`. `/health` reports the service and protocol version without calling PAJ. Check live service access using the client's `provider-check`; it reads rates, chains and banks without creating an order or moving funds.

## Local development

Copy `backend/.dev.vars.example` to `backend/.dev.vars` for local development. This file is ignored by Git. Use `npx wrangler dev --config backend/wrangler.jsonc` and a local D1 migration. Automated tests use a real local Worker/D1 runtime with controlled upstream responses and fake wallet transfers, so no PAJ key or real funds are required.

`npm run backend:types` regenerates bindings from the configuration. `npm run backend:build` produces a deployment dry run. Generated build output and local database state are ignored by Git.

## Limits and recovery

Initial limits in `backend/wrangler.jsonc` are 60 requests per installation per minute, 120 per IP per minute and 5,000 across the service per day. New orders are limited to 20 per installation, 50 per IP and 200 globally per day. These counters share D1 and are updated atomically. IP addresses are stored only as keyed hashes. Rotating installation keys does not reset IP or global allowances. Public access can still be exhausted; these limits do not verify a person's identity or guarantee availability.

Orders are capped at 100 USDC and 500,000 NGN, including a check of the provider's returned amounts. The client also applies its own spending budget and gas reserve. Worker invocation, database read/write and CPU limits still apply; staying within these application limits does not guarantee a particular Cloudflare bill or service level. No paid-plan upgrade is performed by the deployment scripts.

Order creation claims a unique installation/request ID before calling PAJ. Repeating that ID cannot open another provider order. A changed request body is rejected. If PAJ or persistence fails after the claim, the request remains uncertain and is not automatically retried. No wallet transfer happens in this operation. Investigate the operator's PAJ records before deciding how to recover an uncertain order request.

The hourly scheduled task removes expired nonce and quota records. It preserves order records. Completed bank receipt still requires the evidence described in [usage](usage.md); provider completion does not observe the user's bank directly.

Cloudflare operational logs contain error codes only. Request bodies, headers, provider response bodies, API keys and wallet sessions must not be logged.
