# Provider and wallet setup

## PAJ

Obtain a Business API key from the [PAJ dashboard](https://developer.paj.cash/). This integration uses the [PAJ v2 API](https://docs.paj.cash/) at `https://api.paj.cash/pub/v2`, authenticated by `x-api-key`.

Configure your private `.env`:

```dotenv
PAJ_API_KEY=your_business_api_key
PAJ_ENVIRONMENT=production
ARC_NETWORK=mainnet
CIRCLE_ARC_ADDRESS=your_arc_agent_wallet_address
```

Protect the file with `chmod 600 .env`. Keep credentials out of MCP arguments and version control.

## Circle Agent Wallet

Install Circle CLI 1.2.1 or newer and authenticate locally using [Circle's agent wallet setup](https://agents.circle.com/skills/setup.md). The MCP uses that existing session; private keys are not supplied to this project.

Find the agent wallet on Arc:

```sh
circle wallet list --chain ARC --type agent --output json
```

Set its address as `CIRCLE_ARC_ADDRESS`. This is a one-time source-wallet configuration, not an address required on each payment. The wallet needs enough USDC for the provider payment and gas reserve.

## Check access

```sh
npm run doctor
npm run provider:check
```

`doctor` checks local configuration and CLI version. `provider:check` reads the NGN rate, active Arc support, bank directory, authenticated agent-wallet ownership and balance. It does not register recipients or create payment orders.

`livePayoutsAvailable` reflects those current checks. The successful live payment and recipient-confirmed bank credit are documented in [verification evidence](live-integration.md).

## Recipients

Provide the bank name/code, ten-digit account number and expected full holder name when preparing a payment. PAJ resolves the account and the name must match. A one-off recipient does not become the local default.

Saving a default is optional, through `set_default_bank` or `npm start -- set-bank`. PAJ registration happens before approval to save locally, so the provider's registration can remain if local saving is declined.

Arc payments fund the fresh address returned for each order. The standing address returned by PAJ bank registration is not used. Payment preparation requires production and Arc mainnet.

Continue with [MCP and local usage](usage.md).
