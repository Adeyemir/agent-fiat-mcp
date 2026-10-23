# Naira Offramp MCP

**A local MCP server and CLI for paying Nigerian bank accounts using Circle Agent Wallet USDC on Arc.**

## The problem it solves

An agent can already use USDC to pay other agents, APIs and online tools. But paying a person or a business for real-world services often requires naira in a Nigerian bank account.

Naira Offramp connects those payments to the Circle Agent Wallet the agent already uses. It lets a local agent verify a recipient, show the estimated payment costs, request human approval and pay from its USDC balance on Arc through PAJ.

> “Pay this supplier ₦5,000 from my Circle Agent Wallet. Here are their bank details.”

The recipient receives a bank payment; they do not need to accept USDC.

## Local developer scope

This is a developer-only tool. Run this checkout on a computer or developer-managed terminal environment with access to its own Circle CLI session, private configuration and payout database. It connects directly to PAJ using the developer's Business API key.

**Web/mobile browser connectors are unsupported.** This version has no HTTP MCP endpoint, hosted wallet connection, OAuth callback, browser approval page or browser compatibility probe. A web or mobile chat does not inherit the local Circle session.

## Requirements

- Node.js 22.13 or newer and npm.
- Circle CLI 1.2.1 or newer, already authenticated to the existing Circle Agent Wallet.
- The existing agent wallet's Arc address.
- A PAJ production Business API key for bank tools and live payouts.
- Network access to Circle and PAJ. Live preparation requires Arc mainnet and PAJ production.

Reuse the existing Circle executable, login and wallet. This project does not install Circle CLI, accept its Terms, log in or create wallets for you. Do not put login codes or private keys in this repository.

## Install and configure locally

~~~sh
git clone https://github.com/Adeyemir/naira-offramp-mcp.git
cd naira-offramp-mcp
npm ci
npm run build
cp -n .env.example .env
chmod 600 .env
~~~

The copy command preserves an existing .env file. Configure the required values privately in that file:

~~~dotenv
OFFRAMP_MODE=live
CIRCLE_BIN=circle
CIRCLE_ARC_ADDRESS=your_existing_arc_agent_wallet_address
ARC_NETWORK=mainnet
PAJ_ENVIRONMENT=production
PAJ_API_KEY=your_private_paj_business_api_key
~~~

Use an absolute CIRCLE_BIN path if the authenticated executable is not available on the MCP client's PATH. Obtain PAJ credentials from the [PAJ developer dashboard](https://developer.paj.cash/).

### Environment variables

| Variable | Required / default | Purpose |
| --- | --- | --- |
| CIRCLE_ARC_ADDRESS | Required for wallet access and live payouts | Existing Circle Agent Wallet address on Arc. |
| CIRCLE_BIN | Default: circle | Path to the existing authenticated Circle CLI executable. |
| PAJ_API_KEY | Required for PAJ bank tools and live payouts | Private PAJ Business API key, sent as x-api-key. |
| PAJ_ENVIRONMENT | Default: production | Live PAJ v2 operations require production; staging is refused. |
| ARC_NETWORK | Default: mainnet | Live PAJ preparation requires mainnet; testnet cannot fund production orders. |
| OFFRAMP_MODE | Default: live | Use live account tools. The optional demo mode is isolated simulation. |
| OFFRAMP_DATA_DIR | Default: ~/.local/share/naira-offramp-mcp | Local payout and recipient database directory. Use the same directory across restarts and approval. |
| OFFRAMP_MAX_USDC | Default: 100 | Local prepared-payment budget limit, checked with estimated gas. |
| OFFRAMP_NETWORK_FEE_RESERVE_USDC | Default: 0.05 | USDC retained for estimated Arc gas when budgeting a payout. |

**Circle API keys and Entity Secret are not used by this implementation.** Wallet access comes from the existing Circle Agent Wallet CLI session. There are no Circle API-key or Entity-Secret environment variables to configure here. PAJ email/OTP login and legacy PAJ session tokens are also unused; PAJ v2 uses the Business API key directly.

This checkout reads process environment variables and the .env file passed to Node. It does not automatically load the provider.env profile or use the hosted PAJ service from later npm versions. Preserve existing profile files and payout history; do not delete or overwrite them during setup.

## Read-only diagnostics

~~~sh
npm run doctor
npm run provider:check
~~~

Doctor reports local configuration and the Circle CLI version without printing credentials. Provider checks read rates, active chains, bank-directory access, the configured Circle wallet and optional Gateway balance. They do not register recipients, create payment orders or send USDC. Gateway balance is diagnostic only; direct Arc payouts do not require a Gateway deposit.

## Run the local MCP server over stdio

Build first, then launch the server through a local MCP client. Replace both absolute paths:

~~~sh
node --env-file=/absolute/path/naira-offramp-mcp/.env /absolute/path/naira-offramp-mcp/dist/cli.js serve
~~~

A local stdio MCP configuration can use:

~~~json
{
  "mcpServers": {
    "naira-offramp": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/naira-offramp-mcp/.env",
        "/absolute/path/naira-offramp-mcp/dist/cli.js",
        "serve"
      ]
    }
  }
}
~~~

Merge the entry into the client's existing configuration; preserve unrelated servers. Reconnect the client and verify its tools. The MCP client supplies the model, so this project does not require an LLM API key.

For terminal development, npm start runs the same stdio server and npm run dev runs its TypeScript entry point. The server waits for MCP protocol input; it is not an HTTP or browser service.

### Local tools

| Tool | Purpose |
| --- | --- |
| get_balance | Read the configured Arc agent wallet's actual USDC balance. |
| list_banks | Read PAJ's Nigerian bank directory. |
| get_default_bank | Inspect the optional locally saved recipient. |
| set_default_bank | Verify the bank account and holder name, then request human approval to save it locally. |
| get_readiness | Inspect PAJ, Arc and wallet readiness without creating an order. |
| prepare_payout | Create an unfunded PAJ Arc order for a one-off recipient or saved default. |
| execute_payout | Obtain human approval, revalidate the order and submit the Circle transfer once. |
| payout_status | Inspect the existing order and match its settled receipt to the confirmed Circle transfer. |
| payout_history | Inspect local payout history with masked account numbers. |

Saving a recipient and executing a payment through MCP require a client with human approval forms. Tool arguments cannot grant approval. If forms are unavailable, use the interactive terminal workflow below.

## Local CLI prompts and human approval

Use the same .env file and local data directory throughout. These commands act on real PAJ production accounts in live mode; they are not readiness checks.

Verify and optionally save a default recipient, then prepare an unfunded order:

~~~sh
npm start -- set-bank
npm start -- quote 1000 NGN
~~~

The quote command uses the saved default. Through MCP, prepare_payout can instead use a one-off recipient without changing the default.

Review the verified recipient, indicative NGN amount, USDC transfer, estimated network fee, gas reserve and expiry. Only when you intend to pay, run:

~~~sh
npm start -- approve YOUR_PREPARED_PAYOUT_ID
~~~

The terminal displays the payment terms and requires the person to type APPROVE. Piped input and agent-supplied approval flags are refused. A missing approval mechanism must not be bypassed.

## Settlement and recovery

Each payment uses a fresh PAJ Arc order address. The standing Solana address returned by bank registration is not used for Arc payouts. The recipient can be someone other than the wallet owner.

NGN amounts and gas are estimates. PAJ applies its rate when it observes the deposit, and Circle CLI does not enforce a hard gas cap. Local approval expires within at most five minutes and does not lock the exchange rate.

The code checks order identity, source wallet, destination, token, chain and amount, and persists submission before transferring. Ambiguous transfers are retained for reconciliation and never automatically resent.

A completed PAJ receipt must match the confirmed Circle transfer. Provider completion and independent bank-credit confirmation remain separate: the MCP does not query the recipient's bank balance.

The first live payout has recipient-confirmed bank credit recorded in [verification evidence](docs/live-integration.md). See [provider setup](docs/provider-setup.md) and [usage and recovery](docs/usage.md) for the detailed local workflow.

## Development checks

~~~sh
npm run check
npm run build
npm test
~~~

Tests use fake provider/wallet responses and temporary databases. They do not use a real Circle session or move funds. npm run demo explicitly exercises the simulator in an isolated temporary directory; normal startup remains live mode.

[Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
