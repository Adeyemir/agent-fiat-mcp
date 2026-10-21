# Naira Offramp MCP

**Pay Nigerian bank accounts from your Circle Agent Wallet through your AI agent.**

Give your agent an amount and Nigerian bank details. Naira Offramp verifies the recipient, prepares a quote, asks for human approval and uses USDC on Arc to fund the NGN payout through PAJ. The recipient can be a business, supplier or person; you do not need to own their bank account.

**No PAJ account, PAJ API key or LLM API key is required by this package.** Use your AI client's existing model and your own authenticated Circle Agent Wallet. Keep private keys and provider credentials out of chat.

## Choose your setup

| Your environment                                                    | What this release supports                                                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A local stdio MCP client, such as Codex, Claude Code or Antigravity | Register the server, load its nine tools and check readiness. Payments also need a supported human approval flow.    |
| An agent that can run commands but cannot register MCP tools        | Run CLI readiness checks. A person can review payments through the interactive CLI.                                  |
| Ordinary ChatGPT or Claude web/mobile chat                          | End-to-end wallet payments have not been verified. A prompt or npm installation alone does not connect native tools. |

The client controls tool loading and approval capabilities. Choosing Opus or another model does not replace MCP registration. The separate [web/mobile connector preview](https://github.com/Adeyemir/naira-offramp-mcp/blob/main/docs/web-connector.md) is a connection and approval test; it does not connect a wallet or execute payments.

## Set up through your agent

First authenticate your Circle Agent Wallet in the environment where the agent runs. An existing session on your computer is not automatically available in a cloud chat sandbox. Then copy this into an agent with command execution, private file storage and network access:

```text
Set up naira-offramp-mcp@0.2.3 for this AI client. Follow the
"Connect your agent" prompt at:
https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/docs/prompts.md

My Circle Agent Wallet is already logged in in this chat. Reuse its
existing Circle CLI and session; do not reinstall, upgrade, log out,
restart login or create a wallet. Detect my existing Arc agent wallet
and preserve existing configuration. Reuse a correct existing MCP
registration; add it only if needed and supported. Otherwise use the
documented CLI readiness checks. If MCP registration is saved but its
tools are not active, report "configured; awaiting activation" instead
of "setup complete". Report payment approval support separately.
Do not create or fund a payment.
```

Setup does not create a recipient, payment order or transfer. After the tools are connected, use the [payment prompts](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/docs/prompts.md) to check your balance, prepare a payment or track a payout. A copy of the prompt guide is included in the package.

## How it works

1. **Request:** give the agent an amount, bank name, account number and account holder name.
2. **Review:** check the verified recipient, estimated NGN received, USDC charge, gas estimate and expiry.
3. **Approve:** confirm through the client's supported MCP approval form or the human-operated interactive CLI.
4. **Track:** Circle funds the PAJ order from your wallet; the agent checks PAJ's payout status and receipt.

Specify a recipient for each payment, or optionally save a default. The recipient can be someone else. Crypto funding addresses are handled internally.

## Quick start

Requires Node.js **22.13+**, Circle CLI **1.2.1+**, private file storage, and network access to Circle and the hosted payout API. Reuse Circle CLI and the wallet session already authenticated in this environment. The wallet needs USDC on Arc for a payment; funding is not part of setup. This package does not install Circle CLI, start login or create a wallet.

For a development checkout, see the [source installation](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/CONTRIBUTING.md#source-installation).

Create your private configuration once:

```sh
npx --yes naira-offramp-mcp@0.2.3 init
```

Use the returned `provider.env` file, normally at `~/.local/share/naira-offramp-mcp/provider.env`. Preserve an existing wallet configuration; otherwise set `CIRCLE_ARC_ADDRESS` to your authenticated Arc agent wallet. `init` preserves existing configuration. The client connects to the hosted API automatically and creates its own private connection credentials. See [wallet setup](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/docs/provider-setup.md).

Check the setup without moving funds:

```sh
npx --yes naira-offramp-mcp@0.2.3 doctor
npx --yes naira-offramp-mcp@0.2.3 provider-check
```

## Connect your agent

Register the server once in each client that supports local stdio MCP servers. Reuse a correct existing entry and preserve other servers. Installing the npm package alone does not register its tools with your agent. The server uses your client's model; this project does not require an LLM API key.

The client launches the package when it connects and makes its tools available to the agent. This registration tells the app how to start the server; it does not create another wallet. Clients on the same computer can reuse the same Circle session and private profile. Preserve other MCP servers and existing environment settings when adding an entry.

### Codex

```sh
codex mcp add naira-offramp -- npx --yes naira-offramp-mcp@0.2.3
```

### Claude Code

```sh
claude mcp add --transport stdio naira-offramp -- npx --yes naira-offramp-mcp@0.2.3
```

### Antigravity

In Antigravity IDE, open the agent side panel's **… → MCP Servers → Manage MCP Servers → View raw config**. Its current global configuration is `~/.gemini/config/mcp_config.json`; workspace configuration can also live in `.agents/mcp_config.json`. Inspect the active configuration and reuse an existing entry before making changes. See [Antigravity's MCP documentation](https://antigravity.google/docs/mcp).

If missing, merge this entry into the existing `mcpServers` object:

```json
{
  "mcpServers": {
    "naira-offramp": {
      "command": "npx",
      "args": ["--yes", "naira-offramp-mcp@0.2.3"]
    }
  }
}
```

Refresh/reload the connection through the client's MCP manager if available; reconnect or restart Antigravity if activation still requires it. Reuse the existing Circle login. Choosing Opus or another model does not replace this client registration step.

### Other compatible clients

For another compatible client, set the command to `npx` and arguments to `["--yes", "naira-offramp-mcp@0.2.3"]`. Reconnect your client after registration. See the official [Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

You can alternatively run `npm install --global naira-offramp-mcp@0.2.3` and register the `naira-offramp-mcp` command. Both methods run the same MCP server. Configuration and payout history stay outside the installed package, so upgrades preserve them. These examples pin a version; update it deliberately when adopting a new release.

### Verify activation

Writing configuration means **configured**, not yet **connected**. Verify that all nine tools below are available in the current client session, then call `get_readiness` through that MCP connection. While a saved registration has not loaded, report **MCP configured; awaiting activation** and any observed connection error. CLI diagnostics and a separate server test do not verify the client's active tools. Report wallet/provider blockers and payment approval support separately; a successful readiness response does not verify human approval support.

For a client without MCP registration, report **CLI readiness checked; MCP tools unavailable**. If a check fails or has not run, report that specific result instead of claiming setup is complete.

### Payment approval is a separate check

MCP execution requires form elicitation for the package's human approval flow. A client's generic "allow tool" permission does not establish that support. If native approval is unavailable, a person can use [interactive CLI review](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/docs/usage.md#local-human-review). An agent must never submit its own confirmation or bypass approval. If approval support has not been checked, report it as **unverified**; do not create a payment to test it.

Try these requests after connection:

> Show my USDC balance on Arc.

> Prepare a ₦5,000 payment to [bank], account [10-digit number], account holder [full name].

> Execute that prepared payment.

> Check its payout status.

Review the recipient, estimated NGN, USDC charge, gas and expiry before approving. Preparation creates an unfunded provider order; it does not send your USDC.

## Tools

| Tool               | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `get_balance`      | Read the configured Arc wallet's USDC balance.                |
| `list_banks`       | Look up supported Nigerian bank names and codes.              |
| `prepare_payout`   | Verify a recipient and prepare an unfunded payment order.     |
| `execute_payout`   | Obtain human approval, recheck the order and submit once.     |
| `payout_status`    | Track the existing order and match its settlement receipt.    |
| `payout_history`   | List recent local payouts with masked account numbers.        |
| `get_default_bank` | Show the optional saved recipient.                            |
| `set_default_bank` | Verify and save a default recipient after human approval.     |
| `get_readiness`    | Check PAJ access, Arc availability and wallet authentication. |

## Payment semantics

- **NGN requests** specify an indicative receive target. PAJ applies the rate when it observes the deposit.
- **USDC requests** specify a spending budget. A configured reserve is retained for gas; the remainder funds the PAJ order.
- **Gas is estimated.** Circle's CLI does not enforce a hard network-fee cap.
- **Approval expires within five minutes.** Uncertain transfers are recorded and never automatically resent.
- **Provider completion and bank receipt are separate evidence.** PAJ status is tracked automatically; the recipient can separately confirm bank credit.

For a fixed merchant invoice, the calling application must reconcile the final NGN amount and merchant confirmation before marking the purchase paid. See [usage and recovery](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/docs/usage.md).

**Live route verified:** on October 20, 2026, Circle confirmed an Arc USDC transfer, PAJ returned a matching completed payout receipt, and the recipient confirmed receiving the NGN. See [verification evidence](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/docs/live-integration.md). This verifies that payment route; client compatibility and human approval support must still be checked in each environment.

## Wallet and credential storage

Circle authentication, the private payout profile and local payout history stay in the environment where the package runs. Circle sessions and wallet signing keys are not sent to the PAJ backend. The hosted service manages PAJ access, and your wallet funds the approved PAJ order directly. A wallet address alone does not grant spending access.

For your first Circle login, follow [Circle's wallet setup](https://agents.circle.com/skills/setup.md) separately. For an existing login, reuse it. See [wallet setup](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/docs/provider-setup.md) for configuration and [backend deployment](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/docs/backend.md) for operator instructions.

## Development

```sh
npm run format:check
npm run check
npm test
npm run build
npm run test:package
```

Tests use controlled PAJ responses, fake Circle executables and temporary databases. They require no credentials and move no real money. The runtime contains one payment implementation: PAJ v2 with Circle Agent Wallet on Arc.

The [Cloudflare backend](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/docs/backend.md) uses Workers and D1. It validates signed requests, isolates orders per installation, limits usage and records uncertain order creation without automatically retrying it. Developers can self-host the same backend with their own provider credentials.

[Copy a prompt](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/docs/prompts.md) · [Contributing](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/CONTRIBUTING.md) · [Configuration and CLI](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/docs/usage.md) · [Verification](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/docs/live-integration.md)

## License

[MIT](https://github.com/Adeyemir/naira-offramp-mcp/blob/v0.2.3/LICENSE).
