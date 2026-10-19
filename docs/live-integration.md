# Live integration status

**No live Arc-to-NGN route is shipped or verified in this release.** Setting `OFFRAMP_MODE=live` fails with `LIVE_ROUTE_UNAVAILABLE`. Credentials or a verification flag cannot enable it.

## What exists

- A reusable payout service and SQLite store.
- MCP tools for recipient setup, quotes, approval, execution, and inspection.
- A simulated provider and settlement ledger.
- A Circle Agent Wallet helper that calls the Circle CLI with explicit `ARC` arguments, validates the CLI version, and requests typed-data signatures. No private key, Circle API key, or developer-controlled wallet is required by that helper. It has been tested using a fake executable, not a live signature.

The runtime currently selects the simulated adapters only. No live provider client, Gateway deposit, Gateway transfer, or bank payment is wired into it.

## Settlement research

Circle Agent Wallet is the wallet product for this project. The signing helper is glue around that product's CLI. See the official [Agent Wallet signing guide](https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/sign) and [supported blockchains](https://developers.circle.com/agent-stack/agent-wallets/supported-blockchains).

Circle Gateway can move a deposited USDC balance between supported chains. Its [Forwarding Service](https://developers.circle.com/gateway/howtos/forwarding-service) can handle destination minting, and Gateway documents [ERC-1271 signatures](https://developers.circle.com/gateway/references/erc-1271) for smart contract accounts. Gateway supplies USDC settlement, not Nigerian bank payouts.

The reference [PayBot project](https://github.com/MELcodes99/paybot) uses PAJ for NGN payouts. [PAJ's public site](https://paj.cash/) describes Solana token conversion. That does not establish direct Arc support. An Arc-funded route would need a confirmed settlement arrangement with PAJ or another NGN provider. In particular, a Gateway mint must not be assumed to count as payment to a provider deposit address.

These are integration options, not evidence that the combined route works. The customer's funding source remains Arc and the recipient remains a Nigerian bank account.

## Next implementation gate

Before wiring live execution, obtain the payout provider's API access and supported settlement contract:

1. Confirm how an Arc-funded USDC payment is accepted, credited, and linked to an NGN order, including any intermediate settlement network.
2. Confirm recipient verification, actual payout limits, fee semantics, quote expiry, order status, and how failed bank payouts are handled.
3. Implement provider and settlement adapters against that confirmed contract, including reconciliation by the saved payment reference.
4. Verify the Circle Agent Wallet signature path and source funding/deposit flow in the supported environment.
5. Run a separately approved, small live payout and verify actual bank credit before describing the route as working.

The current checks and tests prove the simulated workflow and local control logic. They do not prove provider acceptance, live wallet signing, settlement delivery, or NGN bank credit.
