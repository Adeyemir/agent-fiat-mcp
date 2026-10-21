# Configuration and usage

## Configuration

The CLI reads `provider.env` from `~/.local/share/naira-offramp-mcp`, regardless of its working directory. Run `init` to create the template. Environment variables take precedence over saved values. Set `OFFRAMP_DATA_DIR` in the launching environment to select a different profile; that variable is not read from `provider.env`.

New profiles use the hosted backend automatically. The private `service-identity.json` file authenticates the installation and is generated on the first service request. It is separate from Circle's wallet credentials. Keep this file with the payout database when backing up or moving a profile; replacing it loses access to that installation's hosted orders. This identity represents an installation, not verified personal identity or KYC.

The CLI does not load a working directory's `.env` automatically. Source-checkout scripts such as `npm start` and `npm run dev` still support it through Node's `--env-file-if-exists=.env`; explicit `--env-file` values take precedence over the saved profile. Programmatic callers can use `loadProfileConfig()` for the same behavior, or pass a `Config` directly to `createRuntime()`.

| Variable                           | Default                            | Purpose                                                                |
| ---------------------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `OFFRAMP_BACKEND_URL`              | published service                  | Hosted API HTTPS origin; optional for self-hosting.                    |
| `PAJ_API_KEY`                      | unset                              | Legacy direct mode only; users of the hosted service do not supply it. |
| `CIRCLE_ARC_ADDRESS`               | unset                              | Configured Circle Agent Wallet source on Arc.                          |
| `CIRCLE_BIN`                       | `circle`                           | Circle CLI executable.                                                 |
| `OFFRAMP_DATA_DIR`                 | `~/.local/share/naira-offramp-mcp` | Private local profile.                                                 |
| `OFFRAMP_MAX_USDC`                 | `100`                              | Per-payout spending limit, checked with estimated gas.                 |
| `OFFRAMP_NETWORK_FEE_RESERVE_USDC` | `0.05`                             | USDC retained for estimated gas.                                       |
| `PAJ_ENVIRONMENT`                  | `production`                       | Production is required for payment preparation.                        |
| `ARC_NETWORK`                      | `mainnet`                          | Mainnet is required for payment preparation.                           |

## Prepare a payment

Call `prepare_payout` with decimal-string `amount`, `currency` (`NGN` or `USDC`) and an optional recipient:

```json
{
  "amount": "5000",
  "currency": "NGN",
  "bank": {
    "bank": "BANK_CODE_FROM_LIST_BANKS",
    "accountNumber": "0123456789",
    "expectedName": "FULL ACCOUNT HOLDER NAME"
  }
}
```

The `bank` object selects a one-off recipient. Omit it to use a previously saved default. PAJ verifies the bank account and full name before a fresh Arc order is created. Preparing an order sends no USDC.

An NGN amount is an indicative receive target. A USDC amount is a spending budget: the gas reserve stays in the wallet and the remainder funds the order. The reserve is not an extra PAJ fee. PAJ's business fee is already included in its rate.

Review the resolved recipient, provider payment, estimated NGN, estimated gas, budget and expiry. PAJ applies its rate when the deposit arrives. Circle's CLI does not enforce a hard gas cap, so the final NGN and total debit cannot be guaranteed by this quote.

## Approve and track

Call `execute_payout` with the prepared `payoutId`. The client must support MCP form elicitation and present the complete payment for human approval. A tool argument such as `confirmed: true` cannot approve a transfer.

The service rechecks the existing order, source wallet, expiry, balance and estimated fees, claims the payout in SQLite, records `submitting`, then calls Circle with the payout ID as idempotency key.

Use `payout_status` to poll that order. PAJ `COMPLETED` becomes `provider_completed` with `finalProviderNgn`. `providerTransferMatched` means its receipt matches Circle's confirmed transfer hash, sender, destination, chain, token and amount. The original funding instructions are preserved even when PAJ's final receipt changes its `address` and `createdAt` fields.

`bankCreditIndependentlyVerified` remains false because the tool does not query bank credit. The recipient can separately confirm receipt. A merchant integration should reconcile the final NGN amount and merchant order before recording a purchase as paid.

## Local human review

For clients without human forms, prepare a one-off recipient in an interactive terminal:

```sh
npx --yes naira-offramp-mcp@0.2.3 quote 5000 NGN --recipient
```

The command prompts for recipient details and opens an unfunded order. Alternatively, save an optional default with `npx --yes naira-offramp-mcp@0.2.3 set-bank`, then omit `--recipient` when quoting.

Only when you intend to transfer, review and approve the prepared order:

```sh
npx --yes naira-offramp-mcp@0.2.3 approve YOUR_PREPARED_PAYOUT_ID
```

Read the complete terms and type `APPROVE`. Piped approval is refused. Track the same payment with:

```sh
npx --yes naira-offramp-mcp@0.2.3 status YOUR_PREPARED_PAYOUT_ID
npx --yes naira-offramp-mcp@0.2.3 history
```

The package command without a subcommand runs the stdio MCP server and waits for a client. Installing it alone does not connect an agent: register the server in your MCP client once, as shown in the [README](../README.md#connect-your-agent). For a source checkout, use `node dist/cli.js` in place of the pinned `npx` command.

## Recovery and storage

Approval expires within five minutes and does not lock the exchange rate. PAJ's funding addresses are pooled; an expired address must not be reused. An unfunded order releases its address after roughly two hours, and PAJ removes order records after 72 hours.

`reconciliation_required` means a transfer may already have been submitted. Inspect its saved PAJ order and Circle transaction references. A crash during `authorising` or `submitting` also requires investigation. Repeating execution does not resend, and provider `ERROR` does not create a replacement or imply a refund. Preserve the local database when reconciling a payment.

Profiles retain the `offramp-live-<provider-environment>-<arc-network>.sqlite` filename and existing payout records. Bank defaults are scoped by provider environment and network; payouts also bind the source wallet. New profile directories use mode `0700` and database files use `0600`. Storage is local and not encrypted. Use a separate private profile for each user.

The backend stores its order references, original funding terms, installation ID and usage counters in D1. Bank-account verification and order creation send the requested recipient details to PAJ through the backend. Circle login sessions, wallet private keys and local approval remain on the user's machine. See [backend operations](backend.md) for limits and recovery.
