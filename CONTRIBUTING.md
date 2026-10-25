# Contributing to Agent Fiat MCP

Start with Node.js 22.13+, `npm ci`, and the commands in the README. Keep changes focused on local Circle Agent Wallet funding and naira payouts on Arc. Offramping has live recipient confirmation; onramping still requires a live funding test.

The core interfaces are in `src/types.ts`:

- `OfframpProvider` verifies recipients, quotes orders, and reports the provider's payout status.
- `ArcSettlement` reports spendable funds, prepares fees, authorizes settlement, submits it once, and checks delivery.
- `PayoutService` coordinates approval, limits, persistence, and the payout lifecycle.
- `createMcpServer` exposes that service to an MCP client.

The default live implementation is `LiveService`, using PAJ v2 and Circle Agent Wallet directly on Arc. Its NGN and gas fields are estimates, with no hard CLI gas cap. `PayoutService` remains the generic/simulated lifecycle and must not be used to claim a guaranteed rate for PAJ. Test changes to order identity, pooled-address expiry, source binding, approval, submission persistence and reconciliation before enabling money-moving operations. Provider completion is separate from independently verified bank credit.

Keep financial amounts as integer base units internally and decimal strings at tool boundaries. A USDC budget includes fees. Never infer bank credit from a blockchain transaction, add model-controlled approval booleans, or automatically resend after a timeout.

Use fake adapters and isolated temporary data for tests. Never commit credentials, bank details, wallet sessions, or a local payout database. A proposed live integration needs documentation of the provider contract and how uncertain submissions are reconciled.

Run `npm run check`, `npm run build`, and `npm test` before submitting a change. Document which behavior was tested and which external integrations remain unverified.

Funding logic is in `src/funding-service.ts`, with persisted records in `funding_orders`. Tests must use controlled PAJ responses and fake authenticated wallets, cover uncertain creation and retries across restarts, and distinguish PAJ-reported completion from independently observed wallet credit. Do not add browser/OAuth infrastructure to this local tool. Live funding or payment tests require the user to approve the concrete amount and destination.
