# Copy a prompt

Pay Nigerian bank accounts from Circle Agent Wallet USDC on Arc. Copy a prompt into your connected agent and replace bracketed details.

These prompts are included in both the GitHub repository and npm package, at `docs/prompts.md`. They are instructions for your agent; installing the package alone does not register its MCP tools.

## Connect your agent

Use this setup prompt in a coding agent with access to your computer, terminal and MCP configuration, such as a local Claude Code or Codex session. A web chat without local access cannot install the server or use your local Circle wallet session. Setup requires Node.js 22.13+ and Circle CLI 1.2.1+; the agent should check them first.

```text
Set up Naira Offramp MCP in this AI client so I can pay Nigerian bank
accounts from my Circle Agent Wallet USDC on Arc.

Follow https://github.com/Adeyemir/naira-offramp-mcp and its wallet setup
guide. Use the npm package naira-offramp-mcp@0.2.1 through npx.

1. Check Node.js 22.13+, Circle CLI 1.2.1+ and access to my local machine
   and MCP configuration. Explain any missing prerequisite.
2. Initialize the private profile with
   npx --yes naira-offramp-mcp@0.2.1 init.
   Preserve existing configuration, connection identity and payout history.
3. Reuse my authenticated Circle Agent Wallet on Arc mainnet. Set its
   address in the private profile if needed. If several wallets match,
   ask which to use. Guide me through Circle's local authentication
   flow if needed; keep credentials and verification codes out of chat.
4. Register the MCP under naira-offramp using command npx and arguments
   ["--yes", "naira-offramp-mcp@0.2.1"], using this client's supported
   configuration. Keep unrelated MCP servers unchanged. Tell me if
   I need to restart or reconnect before continuing.
5. Verify all nine tools are available, call get_readiness and explain
   any blockers. Report observed results; setup is complete only after
   the tools connect and readiness succeeds.

The hosted service handles PAJ access. No PAJ account, PAJ API key or
LLM API key is required by this project. My wallet and payment approval
stay local. Do not change the provider or connection identity while a
payment needs reconciliation.

This is setup only. Do not register a bank recipient, create a payment
order, fund the wallet or send money.
```

For exact client commands, see [Connect your agent](../README.md#connect-your-agent). For wallet authentication and configuration, see [wallet setup](provider-setup.md).

## Check your balance

```text
Use Naira Offramp MCP to check readiness and my USDC balance on Arc.
Tell me whether my wallet is connected and explain any setup blockers.
Do not create a payment.
```

## Prepare a payment

```text
Use Naira Offramp MCP to prepare a ₦[amount] payment to:
Bank: [Nigerian bank name]
Account number: [10-digit account number]
Account holder: [full name]

Ask me for any missing recipient details. Use this recipient for this
payment only. Show the verified recipient, estimated NGN received,
USDC charge, estimated gas and expiry for review. Wait for human
approval before executing the payment.
```

NGN amounts and gas are estimates. Preparation creates an unfunded PAJ order; execution uses the MCP's human approval flow. A one-off recipient does not become your default. See [payment semantics](../README.md#payment-semantics).

## Track a payment

```text
Use Naira Offramp MCP to check the existing payment [payout ID].
Report its current status and whether PAJ returned a matching completed
payout receipt. Distinguish that from independent confirmation of bank
credit. If the payment is uncertain, help reconcile the existing order
instead of preparing or sending another payment.
```

Payment IDs and history are saved locally. Use the same private profile that prepared the payment.
