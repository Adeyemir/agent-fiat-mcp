# Contributing

The current scope is payments from Circle Agent Wallet USDC on Arc to Nigerian bank accounts through PAJ. Keep changes focused and explain any changes to payment behavior.

## Development

Use Node.js 22.13 or newer:

```sh
npm ci
npm run format:check
npm run check
npm test
npm run build
```

Tests use fixtures and temporary databases. No PAJ key, authenticated Circle session or real transfer is required. Source and tests are both type checked. Run `npm run format` to apply the shared formatting. CI runs these checks on Node.js 22 and 24.

## Code map

| File                     | Responsibility                                                      |
| ------------------------ | ------------------------------------------------------------------- |
| `src/live-service.ts`    | Recipient selection, quotes, approval, limits and payout lifecycle. |
| `src/providers/paj.ts`   | PAJ v2 authentication, recipient verification, orders and receipts. |
| `src/adapters/circle.ts` | Circle CLI wallet checks, fee estimation and USDC transfers.        |
| `src/store.ts`           | Private SQLite storage and atomic payout state updates.             |
| `src/mcp.ts`             | Tool schemas, human elicitation and public results.                 |
| `src/cli.ts`             | Stdio server, setup diagnostics and local human review.             |
| `tests/fixtures/live.ts` | Controlled provider and wallet implementations for tests.           |

## Payment changes

- Keep amounts as integer base units internally and decimal strings at tool boundaries.
- Bind approval to the resolved recipient, source wallet, existing order, amount and fee terms.
- Preserve the SQLite claim and durable `submitting` record before calling Circle.
- Reuse the payout ID as the transfer's idempotency key. Investigate uncertain submissions instead of resending them.
- Keep order expiry, changed-address, amount, token, network and receipt-matching checks.
- Present NGN and gas as estimates. Do not infer bank credit or merchant fulfilment from a chain receipt.
- Keep credentials, bank details, wallet sessions and payout databases out of commits and public output.

Include tests for behavior changed by a payment-related patch. Distinguish controlled tests from live evidence in the description. Live financial tests require explicit approval of the concrete payment.
