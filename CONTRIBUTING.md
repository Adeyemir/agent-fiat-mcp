# Contributing

Start with Node.js 22.13+, `npm ci`, and the commands in the README. Keep changes focused on Arc USDC to NGN until the first live route is verified.

The core interfaces are in `src/types.ts`:

- `OfframpProvider` verifies recipients, quotes orders, and reports the provider's payout status.
- `ArcSettlement` reports spendable funds, prepares fees, authorizes settlement, submits it once, and checks delivery.
- `PayoutService` coordinates approval, limits, persistence, and the payout lifecycle.
- `createMcpServer` exposes that service to an MCP client.

Keep financial amounts as integer base units internally and decimal strings at tool boundaries. A USDC budget includes fees. Never infer bank credit from a blockchain transaction, add model-controlled approval booleans, or automatically resend after a timeout.

Use fake adapters and isolated temporary data for tests. Never commit credentials, bank details, wallet sessions, or a local payout database. A proposed live integration needs documentation of the provider contract and how uncertain submissions are reconciled.

Run `npm run check`, `npm run build`, and `npm test` before submitting a change. Document which behavior was tested and which external integrations remain unverified.
