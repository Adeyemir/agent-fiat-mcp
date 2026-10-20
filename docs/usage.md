# Configuration and usage

## Configuration

`npm start`, `npm run dev` and setup commands load `.env` from the current directory. An MCP client launching Node directly should pass the absolute `--env-file` path or provide a private environment.

| Variable                           | Default                            | Purpose                                                |
| ---------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `PAJ_API_KEY`                      | unset                              | PAJ Business API key.                                  |
| `CIRCLE_ARC_ADDRESS`               | unset                              | Configured Circle Agent Wallet source on Arc.          |
| `CIRCLE_BIN`                       | `circle`                           | Circle CLI executable.                                 |
| `OFFRAMP_DATA_DIR`                 | `~/.local/share/naira-offramp-mcp` | Private local profile.                                 |
| `OFFRAMP_MAX_USDC`                 | `100`                              | Per-payout spending limit, checked with estimated gas. |
| `OFFRAMP_NETWORK_FEE_RESERVE_USDC` | `0.05`                             | USDC retained for estimated gas.                       |
| `PAJ_ENVIRONMENT`                  | `production`                       | Production is required for payment preparation.        |
| `ARC_NETWORK`                      | `mainnet`                          | Mainnet is required for payment preparation.           |

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
npm start -- quote 5000 NGN --recipient
```

The command prompts for recipient details and opens an unfunded order. Alternatively, save an optional default with `npm start -- set-bank`, then omit `--recipient` when quoting.

Only when you intend to transfer, review and approve the prepared order:

```sh
npm start -- approve YOUR_PREPARED_PAYOUT_ID
```

Read the complete terms and type `APPROVE`. Piped approval is refused. Track the same payment with:

```sh
npm start -- status YOUR_PREPARED_PAYOUT_ID
npm start -- history
```

`npm start` without a subcommand runs the stdio MCP server and waits for a client.

## Recovery and storage

Approval expires within five minutes and does not lock the exchange rate. PAJ's funding addresses are pooled; an expired address must not be reused. An unfunded order releases its address after roughly two hours, and PAJ removes order records after 72 hours.

`reconciliation_required` means a transfer may already have been submitted. Inspect its saved PAJ order and Circle transaction references. A crash during `authorising` or `submitting` also requires investigation. Repeating execution does not resend, and provider `ERROR` does not create a replacement or imply a refund. Preserve the local database when reconciling a payment.

Profiles retain the `offramp-live-<provider-environment>-<arc-network>.sqlite` filename and existing payout records. Bank defaults are scoped by provider environment and network; payouts also bind the source wallet. New profile directories use mode `0700` and database files use `0600`. Storage is local and not encrypted. Use a separate private profile for each user.
