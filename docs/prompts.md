# Copy a prompt

Pay Nigerian bank accounts from Circle Agent Wallet USDC on Arc. Copy a prompt into your connected agent and replace bracketed details.

This guide lives at `docs/prompts.md` in the repository. The npm package includes a version of the guide; GitHub has the current instructions. These prompts are instructions for your agent; installing the package alone does not register its MCP tools.

## Connect your agent

Use this setup prompt in an agent that can run commands, install Node.js packages, write private configuration and reach Circle and the hosted payout API. The execution environment can be your computer or a web agent's cloud sandbox. Setup requires Node.js 22.13+ and Circle CLI 1.2.1+; the agent should check them first.

The available tools and network permissions determine what works. [Circle's setup guide](https://agents.circle.com/skills/setup.md) documents non-interactive login and sandbox networking. [Claude's code execution documentation](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude) describes package installation and network access in web conversations. OpenAI documents separate [cloud browser and code/shell network capabilities](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-cloud-security). Opening a website alone does not establish those permissions, and a cloud sandbox does not inherit your computer's Circle session or payout history.

| Environment capability                                                  | Current setup path                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Command execution plus a configurable stdio MCP host                    | Register the MCP, verify its nine tools and call `get_readiness`. Payment execution also requires human approval support. |
| Command execution without access to the chat client's MCP configuration | Install the package and use its CLI diagnostics in that environment. This does not register native chat tools.            |
| Neither command execution nor a connected MCP                           | A prompt alone cannot run this package. A separate connection is needed.                                                  |

Payment execution currently requires an MCP client with form elicitation or human review in an interactive terminal. Do not substitute an agent-generated confirmation for those flows. An end-to-end payment from the ordinary Claude or ChatGPT web chat has not been verified for this project.

```text
Set up Naira Offramp MCP in this AI client so I can pay Nigerian bank
accounts from my Circle Agent Wallet USDC on Arc.

Follow https://github.com/Adeyemir/naira-offramp-mcp and its wallet setup
guide. Use the npm package naira-offramp-mcp@0.2.1 through npx.

1. Check command execution, Node.js 22.13+, Circle CLI 1.2.1+, private
   file storage and network access to Circle and the hosted payout API.
   Check whether this client supports registering stdio MCP servers.
   Explain missing capabilities; do not reject a runtime just because
   it is accessed through a web browser.
2. Initialize the private profile with
   npx --yes naira-offramp-mcp@0.2.1 init.
   Preserve existing configuration, connection identity and payout history.
3. Reuse my authenticated Circle Agent Wallet on Arc mainnet. Set its
   address in the private profile if needed. If several wallets match,
   ask which to use. If login is needed, follow Circle's official setup
   at https://agents.circle.com/skills/setup.md, including explicit
   consent for its Terms and its two-step email/OTP login. Use a login
   code only for its active authentication request; do not retain it or
   expose persistent credentials. A cloud runtime needs its own session.
4. If this client supports MCP registration, register naira-offramp
   using command npx and arguments ["--yes", "naira-offramp-mcp@0.2.1"].
   Keep unrelated MCP servers unchanged. Tell me if I need to restart
   or reconnect before continuing. Verify all nine tools, then call
   get_readiness and explain any blockers.
5. If MCP registration is unavailable but command execution works, run
   npx --yes naira-offramp-mcp@0.2.1 doctor
   npx --yes naira-offramp-mcp@0.2.1 provider-check
   Explain the observed results and say that CLI access was checked;
   do not claim the web chat has registered MCP tools.
6. Report setup checks and payment-execution support separately.
   Execution requires an MCP human approval form or a human-operated
   interactive terminal. If neither is available, report that payment
   execution is unavailable in this session. Never bypass approval.

The hosted service handles PAJ access. No PAJ account, PAJ API key or
LLM API key is required by this project. Circle sessions and payout
history remain in the agent's execution environment and are not sent
to the PAJ backend. Do not change the provider or connection identity
while a payment needs reconciliation.

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
