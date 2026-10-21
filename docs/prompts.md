# Copy a prompt

Pay Nigerian bank accounts from Circle Agent Wallet USDC on Arc. Copy a prompt into your connected agent and replace bracketed details.

This guide lives at `docs/prompts.md` in the repository. The npm package includes a version of the guide; GitHub has the current instructions. These prompts are instructions for your agent; installing the package alone does not register its MCP tools.

## Connect your agent

This setup assumes Circle Agent Wallet is already authenticated in the same chat's execution environment. Reuse that existing Circle CLI and session. The npm package does not install Circle CLI, create wallets or log in for you.

Each AI client needs its own MCP registration, even when clients share the same local Circle session. Registration tells the client how to launch the package; it does not create another wallet. Reuse a correct existing registration instead of rewriting it. The client controls when configured tools become available to the model, whether the model is Opus or another model.

The agent needs command execution, Node.js 22.13+, private file storage and network access to Circle and the hosted payout API. Its existing Circle CLI must be version 1.2.1 or newer. If Circle is missing, logged out or too old, report the specific blocker; do not reinstall, upgrade or restart login as part of this setup.

The available tools and network permissions determine what works. [Circle's setup guide](https://agents.circle.com/skills/setup.md) documents non-interactive login and sandbox networking. [Claude's code execution documentation](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude) describes package installation and network access in web conversations. OpenAI documents separate [cloud browser and code/shell network capabilities](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-cloud-security). Opening a website alone does not establish those permissions, and a cloud sandbox does not inherit your computer's Circle session or payout history.

| Environment capability                                                  | Current setup path                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Command execution plus a configurable stdio MCP host                    | Register the MCP, verify its nine tools and call `get_readiness`. Payment execution also requires human approval support. |
| Command execution without access to the chat client's MCP configuration | Install the package and use its CLI diagnostics in that environment. This does not register native chat tools.            |
| Neither command execution nor a connected MCP                           | A prompt alone cannot run this package. A separate connection is needed.                                                  |

Payment execution currently requires an MCP client with form elicitation or human review in an interactive terminal. Do not substitute an agent-generated confirmation for those flows. An end-to-end payment from the ordinary Claude or ChatGPT web chat has not been verified for this project.

```text
My Circle Agent Wallet is already set up and logged in in this chat.
Add Naira Offramp so I can pay Nigerian bank accounts from its USDC
balance on Arc. Reuse the existing Circle executable and session.

Follow https://github.com/Adeyemir/naira-offramp-mcp/tree/v0.2.3 and its
wallet setup guide. Use the npm package naira-offramp-mcp@0.2.3 through npx.

1. Check the existing Circle executable, version and wallet session
   using read-only commands. Preserve its existing network/proxy
   settings. Do not install or upgrade Circle CLI, log out, restart
   login, accept Terms or create another wallet. If a prerequisite is
   missing, report it and stop. Also check Node.js 22.13+, private file
   storage and network access to the hosted payout API.
2. Initialize the private profile with
   npx --yes naira-offramp-mcp@0.2.3 init.
   Preserve existing configuration, connection identity and payout history.
3. Read my existing agent wallets with
   circle wallet list --chain ARC --type agent --output json.
   Keep an already-configured, authenticated source wallet. Otherwise
   use the sole matching Arc mainnet agent wallet and set its address
   in the private profile. If several match, ask which one to use.
   Reuse the existing Circle binary path if it differs from circle.
4. If this client supports local stdio MCP registration, identify its
   active configuration using its MCP manager or current official docs.
   Inspect existing registrations first. Reuse a correct naira-offramp
   entry without rewriting it or adding a duplicate, including one
   using an absolute executable path. Otherwise merge only the needed
   entry: command npx, arguments ["--yes", "naira-offramp-mcp@0.2.3"].
   Preserve unrelated MCP servers and existing environment settings.
   Use the client's supported MCP refresh/reload when available. If
   activation requires me to restart or reconnect, report "MCP
   configured; awaiting activation" and give the exact next step.
   Restarting the AI client does not require restarting Circle login.
   Only report "MCP connected" after all nine tools are available in
   this client's current session and its native MCP get_readiness call
   responds. Report any readiness blockers separately. CLI diagnostics,
   a config file or a separate test process cannot prove that this
   client's tools are active. Do not call setup complete or report
   "Blockers: None" while activation or readiness checks are pending.
5. If MCP registration is unavailable but command execution works, run
   npx --yes naira-offramp-mcp@0.2.3 doctor
   npx --yes naira-offramp-mcp@0.2.3 provider-check
   Explain the observed results and say that CLI access was checked;
   do not claim the web chat has registered MCP tools.
6. Report setup checks and payment-execution support separately.
   Execution requires an MCP human approval form or a human-operated
   interactive terminal. If support cannot be checked, report it as
   unverified. If neither is available, report that payment execution
   is unavailable in this session. Client tool permissions alone do
   not prove support for the package's human approval flow. Do not
   create an order or send funds to test approval. Never bypass it.

The hosted service handles PAJ access. No PAJ account, PAJ API key or
LLM API key is required by this project. Circle sessions and payout
history remain in the agent's execution environment and are not sent
to the PAJ backend. Do not change the provider or connection identity
while a payment needs reconciliation.

This is setup only. Do not register a bank recipient, create a payment
order, fund the wallet or send money.
```

For exact client commands, see [Connect your agent](../README.md#connect-your-agent). For wallet authentication and configuration, see [wallet setup](provider-setup.md).

If registration is saved but the client has not loaded it, refresh or reconnect using the client's MCP manager, then continue with:

```text
Continue the existing Naira Offramp setup. Reuse the saved MCP
registration, Circle CLI, wallet session and private profile. Do not
repeat setup or login. Check whether all nine native MCP tools are
available in this session, then call get_readiness through MCP.
Report MCP connection, wallet/provider readiness and payment approval
support separately. If tools are missing, report the client's actual
connection error or that activation is still pending. Do not create
or fund a payment.
```

If you have not connected Circle in this environment yet, complete [Circle's own setup](https://agents.circle.com/skills/setup.md) separately before using this prompt. A Circle session in another chat or runtime is not automatically available here.

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
