# Agent Fiat MCP

**Pay for irl services or businesses in naira from the [Circle Agent Wallet](https://agents.circle.com/) your agent already uses. Fund that same wallet with naira.**

Your agent can pay for APIs and other agents' services in USDC. But a freelancer, supplier or local business may need naira in a bank account.

Agent Fiat MCP connects the two. Your agent verifies the recipient, prepares the payment and asks for your approval. Circle sends USDC from your existing wallet on Arc, and PAJ converts it into a naira bank payment. The recipient receives naira in their account.

Funding works in the other direction: request bank details, transfer naira from your banking app, and PAJ delivers USDC to that same agent wallet.

## Watch the demo

[![Watch the Agent Fiat MCP demo on YouTube](https://img.youtube.com/vi/wron0SObSCQ/hqdefault.jpg)](https://www.youtube.com/watch?v=wron0SObSCQ)

## What you can do

```mermaid
flowchart LR
    Wallet[Circle Agent Wallet on Arc] --> Payout[PAJ payout order]
    Payout --> Bank[Nigerian bank account]
    Bank --> Funding[PAJ funding order]
    Funding --> Wallet
```

| Action | Money flow | Current status |
| --- | --- | --- |
| **Pay someone** | Agent wallet USDC on Arc → PAJ → Nigerian bank account | Tested live; the recipient confirmed bank receipt. |
| **Fund your wallet** | Naira bank transfer → PAJ → USDC in your existing Arc agent wallet | Tested live; 1 USDC credited to the existing wallet on 25 October 2026. |

Both directions have now been tested end to end with real funds on Arc mainnet. The latest funding test converted **₦1,391.68 into 1 USDC**, confirmed through PAJ, the wallet balance and the Arc transaction receipt. See the [verification record and observed timing](docs/live-integration.md#onramp-2026-10-25) for the test scope and measurements.

Once connected to a local agent, you can ask:

> “Pay this freelancer ₦5,000 from my agent wallet. Here are their bank details.”

Review the verified recipient and estimated costs, then approve before the agent sends USDC. You can pay a one-off recipient or save a default.

> “Prepare bank details to add ₦5,000 to my agent wallet.”

The agent returns the bank account, exact naira amount, estimated USDC, receiving wallet and expiry. You review the details and make the transfer yourself in your banking app.

## What you need

This is a **local developer tool** for Nigerian naira ↔ USDC on Arc mainnet. Run it on a computer or terminal environment that can reach Circle and PAJ.

| Requirement | What to provide |
| --- | --- |
| Node.js and npm | Node.js **22.13+** and npm. |
| [Circle Agent Wallet](https://agents.circle.com/) | **Your own wallet on Arc mainnet**, already logged in through Circle CLI **1.2.1+**, and its Arc address. |
| PAJ access | **Your own production Business API key** from the [PAJ developer dashboard](https://developer.paj.cash/). |
| AI client, for MCP use | A client that can launch **local stdio MCP servers**. You can also use the CLI directly without an AI client. |

To **pay someone**, you need USDC in the Arc wallet to cover the payment and network fees, plus the recipient's Nigerian bank name/code, ten-digit account number and full account holder name.

To **fund the wallet**, you need naira in your bank account. The tool returns bank instructions; you make the transfer yourself in your banking app.

**Payout approval:** your MCP client must support human approval forms (MCP form elicitation). Otherwise, review and approve the payout in an interactive terminal.

**Credentials:** configure the PAJ key privately in your local `.env`; do not paste it into chat or commit it. Wallet access uses the Circle CLI session. No Circle API key or Entity Secret is required. The tool needs no LLM API key; your AI client handles its own model access.

**Web/mobile browser connectors are unsupported.** A normal web chat alone cannot run this server or access your local wallet session.

## Setup prompt

Copy this into a local coding agent with terminal access and access to the repository:

```text
Set up Agent Fiat MCP for this local AI client:
https://github.com/Adeyemir/agent-fiat-mcp

Read the README. Reuse an existing checkout or clone and build the source.
Check the required Node.js and Circle CLI versions; report missing prerequisites.

Reuse my existing Circle CLI, login and Arc mainnet agent wallet. Do not
reinstall or upgrade Circle, log out, restart login or create a wallet.
Preserve existing .env files, MCP servers, recipients and payment history.

Help me configure my own PAJ_API_KEY privately in the local .env file.
Never ask me to paste credentials into chat or print their values.
Verify that CIRCLE_ARC_ADDRESS belongs to my authenticated Arc agent wallet.

Run the documented read-only doctor and provider checks. If this client
supports local stdio MCP, register the server using its documented settings
and absolute paths. Confirm that all 13 tools actually load. If a reload is
needed, report "configured; reload required", not "connected". If local MCP
is unsupported, report CLI readiness and any blockers.

Report payment approval support separately: supported, unsupported or
unverified. If MCP approval forms are unavailable, explain terminal approval.

Do not register bank accounts, create payout or funding orders, transfer
money, or use simulated results to claim live readiness during setup.
```

## Get started

Reuse your existing Circle installation, login and wallet. This tool uses that session; it does not manage wallet login or creation.

### 1. Build the project

```sh
git clone https://github.com/Adeyemir/agent-fiat-mcp.git
cd agent-fiat-mcp
npm ci
npm run build
cp -n .env.example .env
chmod 600 .env
```

The copy command preserves an existing `.env`. Use this source checkout for both payment and funding tools; the renamed package has not yet been published to npm.

### 2. Configure your wallet and PAJ access

Set these values privately in `.env`:

```dotenv
CIRCLE_ARC_ADDRESS=your_existing_arc_agent_wallet_address
PAJ_API_KEY=your_private_paj_business_api_key
CIRCLE_BIN=circle
ARC_NETWORK=mainnet
PAJ_ENVIRONMENT=production
OFFRAMP_MODE=live
```

`CIRCLE_ARC_ADDRESS` and `PAJ_API_KEY` are required for the live flows. Use an absolute `CIRCLE_BIN` path if your agent cannot find the authenticated executable on its `PATH`.

PAJ uses the Business API key directly; PAJ email/OTP login is not needed.

### 3. Check the connection

```sh
npm run doctor
npm run provider:check
```

These read-only checks inspect configuration, wallet access, PAJ rates, banks and Arc availability. They create no orders and move no money. Gateway balance is an optional diagnostic; this route needs no Gateway deposit.

### 4. Connect your local agent

Use your client's documented local stdio MCP configuration. For clients using `mcpServers`, merge this entry with existing servers and replace the absolute paths:

```json
{
  "mcpServers": {
    "agent-fiat": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/agent-fiat-mcp/.env",
        "/absolute/path/agent-fiat-mcp/dist/cli.js",
        "serve"
      ]
    }
  }
}
```

Reload the client and confirm that the tools appear. Ask the agent to check readiness and your Arc USDC balance, then check payment approval support separately. A saved configuration alone does not confirm a working connection.

The underlying server command is:

```sh
node --env-file=/absolute/path/agent-fiat-mcp/.env /absolute/path/agent-fiat-mcp/dist/cli.js serve
```

It communicates through stdio and waits for the MCP client. There is no browser URL to open.

The live server exposes 13 tools:

| Purpose | Tools |
| --- | --- |
| Wallet and readiness | `get_balance`, `get_readiness` |
| Bank accounts | `list_banks`, `get_default_bank`, `set_default_bank` |
| Pay someone | `prepare_payout`, `execute_payout`, `payout_status`, `payout_history` |
| Fund your wallet | `prepare_funding`, `funding_status`, `funding_history` |
| Get a receipt | `get_receipt` |

## Use the terminal

Run these commands from the checkout with the same `.env` and data directory throughout. **`quote` and `fund` create real, initially unfunded PAJ orders.**

### Pay a Nigerian bank account

Verify and save a recipient, then prepare an estimated ₦5,000 payment:

```sh
npm start -- set-bank
npm start -- quote 5000 NGN
```

The CLI uses the saved recipient. MCP also supports a one-off recipient without changing your default. Preparation sends no USDC.

Review the recipient, estimated naira payout, USDC transfer, network fee, reserve and expiry. To proceed with that prepared payment:

```sh
npm start -- approve YOUR_PREPARED_PAYOUT_ID
```

Read the displayed terms and type `APPROVE` yourself. The terminal must be interactive; piped input and agent-supplied approval flags are refused.

### Fund the existing wallet

```sh
npm start -- fund 5000
```

Review the bank instructions, exact amount, receiving wallet and expiry, then pay from your banking app. The receiving address is checked against your authenticated Arc agent wallet. Track the returned funding ID:

```sh
npm start -- funding-status YOUR_FUNDING_ID
npm start -- funding-history
```

Preparation reuses an active funding order for the same amount. A different amount is blocked while an order is active. Pay only the current instructions returned by the tool; never reuse an expired account.

### Get a receipt

Completed `funding_status` and `payout_status` results automatically include a text receipt and the path to a local SVG receipt card. You can retrieve either receipt again:

```sh
npm start -- receipt YOUR_LOCAL_FUNDING_OR_PAYOUT_ID
```

For MCP, call `get_receipt` with `{ "id": "YOUR_LOCAL_FUNDING_OR_PAYOUT_ID" }`. The SVG is saved to `receipts/<id>.svg` inside `OFFRAMP_DATA_DIR` (default: `~/.local/share/naira-offramp-mcp`). Open that file to view or share the card; it contains payment details, with bank account numbers limited to their last four digits.

Receipts show the final NGN and USDC amounts, PAJ status, wallet credit status, Arc confirmation, wallet address, timestamp, full transaction hash and an explorer link. Arc verification checks the expected USDC transfer against the chain. Balance changes appear only when both observations were recorded; older orders may show **Not recorded**. PAJ completion remains a provider report of bank settlement, not independent proof that a recipient's bank credited the account.

## Amounts, settlement and interrupted requests

- **Amounts are estimates.** PAJ applies its rate when the deposit arrives. Circle estimates gas without a hard gas cap. Approval does not lock rates or guarantee the final received amount or total wallet debit.
- **Approval belongs to the person.** Saving a recipient and executing a payout require MCP forms or an interactive terminal. A tool argument cannot grant approval.
- **Delivery needs confirmation.** Receipts separate PAJ's settlement report from independently checked Arc transfers. Missing evidence stays unverified; bank credit is not independently checked. See the [live payment and funding evidence](docs/live-integration.md#verification-evidence).
- **Keep uncertain requests for investigation.** Check the existing ID with `payout_status` or `funding_status`. Do not send again, create a replacement or delete the database to retry. Errors do not establish refunds.

See [usage and recovery](docs/usage.md) and [PAJ setup and settlement](docs/provider-setup.md) for the detailed behavior.

## Configuration and existing installations

Optional settings for the data directory, payout budget and gas reserve are in the [configuration reference](docs/usage.md#configuration).

The rename preserves `OFFRAMP_*` settings and the default `~/.local/share/naira-offramp-mcp` data directory. Keep your existing recipients, history and private profile files. Configuration comes from the process environment and the `.env` passed to Node; older `provider.env` files are not loaded automatically.

The existing npm release, `naira-offramp-mcp@0.3.0`, contains the earlier payout-only implementation. It does not include the funding or receipt tools in this checkout.

## Development

```sh
npm run check
npm run build
npm test
```

Tests use fake wallet/provider responses and temporary databases; they move no funds. `npm run demo` runs the payout simulator in an isolated temporary profile. Normal startup uses live mode.

[Integration evidence](docs/live-integration.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
