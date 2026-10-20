# PAJ provider setup

## Current status

The HTTP client is implemented from PAJ's [official API reference](https://github.com/paj-cash/paj_ramp/blob/main/lib/API_REFERENCE.md), repository revision `6205abba52efeafb401572ff1cfdf8e8b0c381ec`, checked 2026-10-19. The default MCP uses it for the Nigerian bank directory and exact account/name verification, with human approval before saving a recipient locally. Order creation and funding are not connected to the MCP. Provider access does not enable live payouts.

## Get API access

Use your own account at the [PAJ Business dashboard](https://developer.paj.cash/). Obtain a Business API key for the intended API environment. If the dashboard requires onboarding or approval, complete that with PAJ; this project cannot issue keys.

Copy `.env.example` to `.env` locally, restrict the file to your user (`chmod 600 .env`), and set:

```dotenv
OFFRAMP_MODE=live
PAJ_ENVIRONMENT=production
ARC_NETWORK=mainnet
PAJ_API_KEY=your_business_key
PAJ_EMAIL=your_account_email
```

Keep the key out of chat and source control. These variables are configuration for provider diagnostics and local login. The PAJ environment and blockchain network are separate choices: PAJ staging is not evidence that a deposit address accepts testnet tokens. No staging order should be funded until PAJ confirms the token and network.

## Authenticate locally

```sh
npm run provider:login
```

The command requires an interactive terminal. It shows the email and API environment, asks you to type `SEND`, then requests the OTP. Enter the code locally. A session token is saved with mode `0600` to `paj-session-staging.json` in your private `OFFRAMP_DATA_DIR`. Production sessions use a separate file. API keys and OTPs are not saved in those files or returned to the agent. This login is separate from Circle Agent Wallet login.

Alternatively, supply an existing `PAJ_SESSION_TOKEN` for the selected environment through your private environment. This takes precedence over a saved session. Expired saved sessions are rejected; the server does not silently request a new OTP.

## Check access without moving funds

```sh
npm run provider:check
```

This fetches the public off-ramp rate and Gateway supported chains. If a session exists, it checks access to the authenticated Nigerian bank directory. With `CIRCLE_ARC_ADDRESS` configured, it reads the Arc wallet balance through your existing Circle session and separately queries that wallet's Arc Gateway deposit balance. These real diagnostic balances do not fund demo payouts. It does not resolve a real account, create a beneficiary, create a payout order, request a wallet signature, or move funds. `livePayoutsAvailable` remains false.

The same operation is available through the `get_readiness` MCP tool. Provider login is a local setup operation, not an MCP tool. Restart your MCP client after adding the tool or changing its environment. If your client launches Node directly, configure an absolute `--env-file-if-exists=/absolute/path/to/.env` argument before `dist/cli.js`, or pass variables in the client's private environment. Do not put credentials in a checked-in MCP configuration.

The published rate endpoint currently omits `isActive`, although the reference example includes it. The client reports `active: null` when absent. The response's `createdAt` is preserved without assuming it is a rate update time or a quote expiry. An indicative rate response is not a locked payout quote.

## Settlement review — 2026-10-20

PAJ's [published API reference](https://github.com/paj-cash/paj_ramp/blob/main/lib/API_REFERENCE.md) still lists `SOLANA` and `MONAD` in its settlement-chain enum, with no documented `ARC` option. Circle's [Forwarding Service guide](https://developers.circle.com/gateway/howtos/forwarding-service) documents cross-chain destination minting, including recipient token-account setup. This establishes a possible transport mechanism; it does not establish PAJ's acceptance or order attribution.

### Message to send PAJ

> Hi PAJ team, I'm building naira-offramp-mcp, an open-source tool that converts USDC held on Arc in Circle Agent Wallet into NGN in a saved Nigerian bank account. Business API login works.
>
> Do you support direct Arc USDC deposits? If not, can Circle Gateway's Forwarding Service mint USDC into a PAJ order's deposit account and have it credited automatically? Please confirm the supported API chain, USDC token, recipient format, and any sender or transaction-reference requirements.
>
> Also, does POST /pub/offramp expect the bank-directory ID or the saved bank-account ID? Your reference's sections 9 and 14 describe different IDs.
>
> Please share the fee, expiry, minimum/maximum payout, and bank-credit confirmation rules for that route before we fund a test order.

The maintainer sent the settlement inquiry to PAJ on 2026-10-20. A reply and route confirmation are pending. No API keys, session tokens, wallet addresses, or bank details are needed in the initial inquiry.

### Details to confirm before funding an order

1. Do you accept USDC on Arc directly? If not, which settlement network, USDC token, API environment, and deposit-recipient format should an Arc-funded integration use?
2. Do you credit USDC minted into the order deposit account by Circle Gateway's Forwarding Service? Does funding require a normal token transfer, a specific sender, or another attribution step?
3. For `POST /pub/offramp`, is `bank` the bank-directory ID or the saved-account ID? Sections 9 and 14 of the reference describe different IDs.
4. Is response `amount` the complete USDC deposit amount, and is `fiatAmount` the net NGN credited? How are fees, taxes, quote expiry, late deposits, and changed rates handled?
5. What limits and account eligibility apply to this Business API integration? How can an order be reconciled after a timeout without creating a replacement payment?
6. Does polled `COMPLETED` mean bank credit is confirmed? Is there a bank reference or payout receipt? How are webhook authenticity, failed bank payouts, and refunds handled?

Keep these answers with the integration evidence. The next code step is to bind the verified provider order to the settlement adapter, retain the payment reference before submission, and perform a separately approved small live test. The user-facing request remains USDC on Arc to the saved Nigerian bank account, with no settlement-address entry.
