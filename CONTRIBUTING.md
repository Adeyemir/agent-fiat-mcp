# Contributing

The current scope is payments from Circle Agent Wallet USDC on Arc to Nigerian bank accounts through PAJ. Keep changes focused and explain any changes to payment behavior.

## Source installation

Use Node.js 22.13 or newer:

```sh
git clone https://github.com/Adeyemir/naira-offramp-mcp.git
cd naira-offramp-mcp
npm ci
npm run build
node dist/cli.js init
```

Set `CIRCLE_ARC_ADDRESS` in the `provider.env` path printed by `init`, and authenticate through Circle. The source client uses the same hosted backend as the npm package. Check access with `npm run doctor` and `npm run provider:check`. PAJ keys are required only when operating a backend or an existing direct-mode integration; see [backend deployment](docs/backend.md).

For a local build, register `node /absolute/path/naira-offramp-mcp/dist/cli.js` as the MCP server command. It reads the same private profile as the npm package. Existing checkouts using an explicit Node `--env-file` remain supported.

## Development

```sh
npm run format:check
npm run check
npm run backend:check
npm test
npm run backend:test
npm run test:package
```

Tests use fixtures and temporary databases. No PAJ key, authenticated Circle session or real transfer is required. Source and TypeScript tests are type checked. Backend tests run the compiled Worker with real local D1 storage and controlled outbound HTTP responses. Miniflare is aligned with the version bundled by Wrangler. `test:package` builds a tarball, installs its production dependencies in a temporary directory, and checks the installed executable, private profile and MCP protocol from another working directory. It needs registry access to install dependencies. Run `npm run format` to apply the shared formatting. CI runs these checks on Node.js 22 and 24.

## Code map

| File                     | Responsibility                                                      |
| ------------------------ | ------------------------------------------------------------------- |
| `src/live-service.ts`    | Recipient selection, quotes, approval, limits and payout lifecycle. |
| `src/providers/paj.ts`   | PAJ v2 authentication, recipient verification, orders and receipts. |
| `src/adapters/circle.ts` | Circle CLI wallet checks, fee estimation and USDC transfers.        |
| `src/store.ts`           | Private SQLite storage and atomic payout state updates.             |
| `src/mcp.ts`             | Tool schemas, human elicitation and public results.                 |
| `src/cli.ts`             | Stdio server, setup diagnostics and local human review.             |
| `src/profile.ts`         | Private configuration initialization and environment overrides.     |
| `tests/fixtures/live.ts` | Controlled provider and wallet implementations for tests.           |

## Payment changes

Hosted connection code is in `src/providers/hosted.ts`; the Worker is in `backend/src/index.ts`, with its D1 schema in `backend/migrations`. `src/hosted-protocol.ts` defines the signed request format.

- Keep amounts as integer base units internally and decimal strings at tool boundaries.
- Bind approval to the resolved recipient, source wallet, existing order, amount and fee terms.
- Preserve the SQLite claim and durable `submitting` record before calling Circle.
- Reuse the payout ID as the transfer's idempotency key. Investigate uncertain submissions instead of resending them.
- Keep order expiry, changed-address, amount, token, network and receipt-matching checks.
- Present NGN and gas as estimates. Do not infer bank credit or merchant fulfilment from a chain receipt.
- Keep credentials, bank details, wallet sessions and payout databases out of commits and public output.

Include tests for behavior changed by a payment-related patch. Distinguish controlled tests from live evidence in the description. Live financial tests require explicit approval of the concrete payment.

## Publishing

The package is published to the public npm registry as `naira-offramp-mcp`. Maintainers need an authenticated npm account with publishing access. Run the development checks and inspect `npm pack --dry-run` before publishing. `prepack` rebuilds `dist` so the tarball contains the current source. The `files` allowlist excludes credentials, databases, source fixtures and development scripts.

After publishing, verify the registry version and the pinned `npx` instructions from a clean directory.

Keep `src/backend-endpoint.ts` set to the verified public deployment before releasing the hosted client. The package must never contain backend secrets or wallet credentials. Changes to bank verification, hosted authentication, ownership or request idempotency require relevant integration tests.
