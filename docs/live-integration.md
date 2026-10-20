# Live integration status

**Live wallet and bank setup is the default. Arc-to-NGN cashout settlement is still unfinished and unverified.** `OFFRAMP_MODE=live` runs the real account tools; it does not register payout tools or substitute a simulator. No verification flag enables cashouts.

## What exists

- A reusable payout service and SQLite store.
- Default MCP tools for real wallet balances, the PAJ bank directory, account/name verification, local recipient setup after human approval, and integration status.
- A payout lifecycle service with quote, approval, execution and inspection logic, currently exercised through explicitly selected simulation and tests.
- A development simulator with separate storage, enabled only through `OFFRAMP_MODE=demo` or the isolated `npm run demo` script.
- A Circle Agent Wallet helper that calls the Circle CLI with explicit `ARC-TESTNET` or `ARC` arguments, validates the CLI version, reads the six-decimal USDC token balance, and requests typed-data signatures. Testnet is the default; mainnet must be selected explicitly. No private key, Circle API key, or developer-controlled wallet is required by that helper. Balance reads have been verified against an authenticated mainnet wallet; signing has been tested using a fake executable, not a live signature.
- A PAJ HTTP client for sessions, NGN bank verification, bank storage, rates, order creation, and order inspection; a local login helper stores the resulting session privately.
- A read-only readiness command and MCP tool that query PAJ, Circle Agent Wallet, and Gateway and report unresolved integration requirements. Real wallet USDC and Arc Gateway deposit balances are reported separately from the simulated payout ledger.

The default runtime uses Circle Agent Wallet for actual balances and PAJ for recipient verification. Verified recipients are saved locally, separately from demo data. Gateway deposit, Gateway transfer, provider order funding, and real bank payment are not wired into payout execution.

## Settlement research

Circle Agent Wallet is the wallet product for this project. The signing helper is glue around that product's CLI. See the official [Agent Wallet signing guide](https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/sign) and [supported blockchains](https://developers.circle.com/agent-stack/agent-wallets/supported-blockchains).

Circle Gateway can move a deposited USDC balance between supported chains. Its [Forwarding Service](https://developers.circle.com/gateway/howtos/forwarding-service) can handle destination minting, and Gateway documents [ERC-1271 signatures](https://developers.circle.com/gateway/references/erc-1271) for smart contract accounts. Gateway supplies USDC settlement, not Nigerian bank payouts.

The reference [PayBot project](https://github.com/MELcodes99/paybot) uses PAJ for NGN payouts. PAJ's newer [V2 announcement](https://paj.cash/blog/PAJ-V2-Is-Live-And-It-Just-Changed-What-Crypto-Payments-Mean-in-Africa) and [official API reference](https://github.com/paj-cash/paj_ramp/blob/main/lib/API_REFERENCE.md) list `SOLANA` and `MONAD` as settlement chains. They do not document direct Arc settlement. Gateway's [published supported chains](https://developers.circle.com/gateway/references/supported-blockchains) and public `/v1/info` response were checked on 2026-10-19: Arc and Solana were present; Monad was absent. Chain lists may change, so the readiness command checks the selected Gateway environment again.

An Arc-funded route needs a confirmed settlement arrangement with PAJ or another NGN provider. A Gateway destination mint must not be assumed to count as payment to a provider deposit address. The raw PAJ client refuses a made-up `chain: "ARC"` request.

The PAJ reference does not specify an order expiry guarantee. Its bank parameter is shown as a bank-directory ID in section 9 and as a saved-account ID in section 14. Those semantics need confirmation before wiring live payout execution. The raw client requires the caller to supply the provider's bank reference explicitly and does not invent an expiry or add `fee` to the quoted `amount` a second time.

These are integration options, not evidence that the combined route works. The customer's funding source remains Arc and the recipient remains a Nigerian bank account.

## Next implementation gate

Before wiring live execution, obtain the payout provider's API access and supported settlement contract:

1. Confirm how an Arc-funded USDC payment is accepted, credited, and linked to an NGN order, including any intermediate settlement network.
2. Confirm recipient verification, actual payout limits, fee semantics, quote expiry, order status, and how failed bank payouts are handled.
3. Implement provider and settlement adapters against that confirmed contract, including reconciliation by the saved payment reference.
4. Verify the Circle Agent Wallet signature path and source funding/deposit flow in the supported environment.
5. Run a separately approved, small live payout and verify actual bank credit before describing the route as working.

The current checks and tests prove the simulated workflow, local control logic, API request/response validation using mocks, and public API connectivity. Production session login succeeded on 2026-10-20. The production bank directory included entries without names; the client excludes them from bank selection. Authenticated bank-directory access does not prove provider settlement acceptance, live wallet signing, settlement delivery, or NGN bank credit. See [provider setup and confirmation questions](provider-setup.md).
