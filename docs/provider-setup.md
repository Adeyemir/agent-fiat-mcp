# PAJ v2 setup

The current contract is [docs.paj.cash](https://docs.paj.cash/), including its [OpenAPI specification](https://docs.paj.cash/api-reference/openapi.json). The older GitHub/session-based reference used by previous commits is superseded.

## Credentials

Obtain your Business API key from the [PAJ dashboard](https://developer.paj.cash/). Set these in your private environment:

```dotenv
OFFRAMP_MODE=live
PAJ_ENVIRONMENT=production
ARC_NETWORK=mainnet
PAJ_API_KEY=your_business_key
CIRCLE_ARC_ADDRESS=your_saved_circle_agent_wallet
```

Restrict the environment file to your user (`chmod 600 .env`). V2 sends `x-api-key` on every request. It does not use PAJ email login, OTP verification or session tokens. Existing private session files and `PAJ_SESSION_TOKEN` are ignored. The compatibility `provider:login` command explains this without requesting a code. Circle Agent Wallet login remains separate.

PAJ's v2 documentation lists production only. The client refuses an unverified staging v2 environment; payout preparation also refuses Arc testnet. A testnet token must never fund a production order.

## Read-only check

```sh
npm run provider:check
```

This reads v2 NGN onramp/offramp rates, the live chain list and the Nigerian bank directory. It checks the configured Circle wallet, with its Arc Gateway deposit balance reported separately as optional diagnostics. It does not register a bank, open an order or transfer money. Gateway is not required for direct Arc settlement.

`livePayoutsAvailable` means the configured account/network checks passed and the implementation can be used. Readiness does not run a payout or ingest recipient confirmations, so its verification flags remain conservative. The [integration evidence](live-integration.md#verification-evidence) separately records the first successful live payout and the recipient's confirmation of bank credit.

## Choose a recipient

For a one-off recipient, supply the bank name/code, ten-digit account number and expected full holder name in `prepare_payout`'s `bank` input. The recipient need not be you, and this does not change your local default.

### Optional default

Use `set_default_bank` through MCP or enter details locally:

```sh
npm start -- set-bank
```

Provide the Nigerian bank name/code, ten-digit account number and expected full holder name. V2 verifies and registers the account with `POST /pub/v2/bank-account`, using `bankCode` and `accountNumber`. The resolved name and bank must match before local saving is offered. Review the details and approve saving them locally.

Registration is idempotent. Declining local saving leaves the provider's registration in place. The returned standing address is Solana-only and is deliberately discarded for this Arc integration. Arc funding always uses a fresh order address.

## Prepare, review and approve

Ask the MCP to prepare a small provider-accepted NGN target, or use the local command:

```sh
npm start -- quote 1000 NGN
```

This opens a real, initially unfunded PAJ Arc order, estimates the Circle transfer fee and saves a local payout ID. It sends no USDC. A rejected provider amount is not retried automatically.

Review the recipient, indicative NGN, USDC transfer, estimated network fee and fee reserve. NGN is finalized at deposit observation; Circle's CLI does not expose a hard gas cap. The approval window lasts at most five minutes and is not a rate lock.

Only when you intend to move funds, approve the prepared payout through the MCP client's human dialog or a local interactive terminal:

```sh
npm start -- approve YOUR_PREPARED_PAYOUT_ID
```

The terminal displays the complete terms and requires `APPROVE`. Piped approval and model-supplied approval arguments are refused. Cashouts use the saved wallet and either an explicitly specified recipient or an optional default bank; crypto destination addresses are not requested from the user. The local `quote` command uses the saved default; the MCP supports one-off recipients.

## Polling and recovery

V2 uses `GET /pub/v2/transaction/{id}`. Provider `COMPLETED` becomes `provider_completed` in this MCP. PAJ describes it as NGN having been sent to the bank; the MCP does not independently observe bank credit, so `bankPaid` remains false. The recipient can separately confirm the actual bank credit.

After a timeout, inspect the existing payout. Its provider order ID is retained; its local payout ID is also the Circle idempotency key. A known Circle transaction ID is saved. `reconciliation_required` is never automatically resubmitted, and `ERROR` does not trigger a replacement or automatic refund.

The first live test completed with a confirmed Circle transfer, a matching completed PAJ receipt and the recipient's confirmation of bank credit. See [integration status](live-integration.md).
