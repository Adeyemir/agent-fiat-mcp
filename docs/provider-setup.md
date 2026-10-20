# Wallet and service setup

For setup through your coding agent, use the [copyable setup prompt](prompts.md#connect-your-agent).

## Hosted service

The standard npm client uses the project's hosted payout API. PAJ credentials stay on that server. Users do not need a PAJ account, a PAJ key or a manually entered app API key. The client creates and saves a private signing identity for its own connection.

Run `npx --yes naira-offramp-mcp@0.2.1 init` once, then edit the private `provider.env` path it prints:

```dotenv
ARC_NETWORK=mainnet
CIRCLE_ARC_ADDRESS=your_arc_agent_wallet_address
```

`init` creates the file with mode `0600` and never overwrites an existing file. Each user authenticates to their own Circle Agent Wallet in the agent's execution environment, which can be their computer or a cloud sandbox. A sandbox does not inherit the session or payout files from another environment. Wallet sessions and signing keys are not sent to the payout backend.

## Circle Agent Wallet

Install Circle CLI 1.2.1 or newer and authenticate in that environment using [Circle's agent wallet setup](https://agents.circle.com/skills/setup.md). It documents a non-interactive email/OTP login and sandbox network requirements. The MCP uses that session; private keys are not supplied to this project.

Find the agent wallet on Arc:

```sh
circle wallet list --chain ARC --type agent --output json
```

Set its address as `CIRCLE_ARC_ADDRESS`. This is a one-time source-wallet configuration, not an address required on each payment. The wallet needs enough USDC for the provider payment and gas reserve.

## Check access

```sh
npx --yes naira-offramp-mcp@0.2.1 doctor
npx --yes naira-offramp-mcp@0.2.1 provider-check
```

`doctor` checks local configuration and CLI version. `provider-check` reads the NGN rate, active Arc support, bank directory, authenticated agent-wallet ownership and balance. It does not register recipients or create payment orders. For a source checkout, use `node dist/cli.js` in place of the pinned `npx` command.

`livePayoutsAvailable` reflects those current checks. The successful live payment and recipient-confirmed bank credit are documented in [verification evidence](live-integration.md).

## Recipients

Provide the bank name/code, ten-digit account number and expected full holder name when preparing a payment. PAJ resolves the account and the name must match. A one-off recipient does not become the local default.

Saving a default is optional, through `set_default_bank` or `npx --yes naira-offramp-mcp@0.2.1 set-bank`. PAJ registration happens before approval to save locally, so the provider's registration can remain if local saving is declined.

Arc payments fund the fresh address returned for each order. The standing address returned by PAJ bank registration is not used. Payment preparation requires production and Arc mainnet.

Continue with [MCP and local usage](usage.md).

## Operators and existing direct installations

See [backend deployment](backend.md) to operate the shared service. A PAJ key belongs in the backend's secret storage.

Existing profiles with `PAJ_API_KEY` and no `OFFRAMP_BACKEND_URL` keep using PAJ directly. This preserves access to their existing orders. To migrate after reconciling pending orders, set `OFFRAMP_BACKEND_URL` to the hosted API origin. Do not change provider or connection identity while an order needs reconciliation.
