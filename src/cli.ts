#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initProfile, loadProfileConfig } from "./profile.js";
import { packageInfo } from "./package-info.js";
import { CircleAgent } from "./adapters/circle.js";
import { publicError, requireThat } from "./errors.js";
import { createMcpServer, payoutApprovalMessage } from "./mcp.js";
import { createRuntime } from "./runtime.js";
import { inspectReadiness } from "./readiness.js";
import type { BankInput } from "./types.js";

async function readBank(reader: ReturnType<typeof createInterface>): Promise<BankInput> {
  return {
    bank: (await reader.question("Nigerian bank name or code: ")).trim(),
    accountNumber: (await reader.question("Ten-digit account number: ")).trim(),
    expectedName: (await reader.question("Full account holder name: ")).trim(),
  };
}

async function doctor() {
  const config = loadProfileConfig();
  let circleVersion: unknown = "Not checked: no Arc agent wallet configured.";
  if (config.arcAddress) {
    try {
      circleVersion = await new CircleAgent(
        config.circleBin,
        config.arcAddress,
        config.arcNetwork,
      ).checkVersion();
    } catch (error) {
      circleVersion = publicError(error);
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        dataDir: config.dataDir,
        circleAgentWalletConfigured: Boolean(config.arcAddress),
        circleVersion,
        providerEnvironment: config.pajEnvironment,
        arcNetwork: config.arcNetwork,
        providerApiVersion: "v2",
        providerConnection: config.backendUrl ? "hosted" : "direct",
        backendUrl: config.backendUrl,
        providerApiKeyConfigured: config.backendUrl ? undefined : Boolean(config.pajApiKey),
        nextStep: "Run provider-check, connect your MCP client, then prepare a payout for review.",
      },
      null,
      2,
    ),
  );
}

async function main() {
  const [command, payoutId, ...extra] = process.argv.slice(2);
  if (command === "init") {
    requireThat(payoutId === undefined, "INVALID_COMMAND", "init takes no arguments.");
    console.log(
      JSON.stringify(
        {
          ...initProfile(),
          nextStep:
            "Connect your Circle Agent Wallet, set CIRCLE_ARC_ADDRESS in this private file, then run provider-check and register the MCP server. The hosted service manages PAJ access; no PAJ key is needed.",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "--version") {
    requireThat(payoutId === undefined, "INVALID_COMMAND", "--version takes no arguments.");
    console.log(packageInfo.version);
    return;
  }
  if (command === "doctor") {
    requireThat(payoutId === undefined, "INVALID_COMMAND", "doctor takes no arguments.");
    return doctor();
  }
  if (command === "provider-check") {
    requireThat(payoutId === undefined, "INVALID_COMMAND", "provider-check takes no arguments.");
    const readiness = await inspectReadiness(loadProfileConfig());
    console.log(JSON.stringify(readiness, null, 2));
    if (!readiness.livePayoutsAvailable) process.exitCode = 1;
    return;
  }
  if (command === "quote") {
    requireThat(
      payoutId &&
        (extra.length === 1 || (extra.length === 2 && extra[1] === "--recipient")) &&
        (extra[0] === "NGN" || extra[0] === "USDC"),
      "INVALID_COMMAND",
      "Use quote <amount> <NGN|USDC> [--recipient]. This prepares an unfunded order.",
    );
    const oneOff = extra[1] === "--recipient";
    requireThat(
      !oneOff || (process.stdin.isTTY && process.stdout.isTTY),
      "INTERACTIVE_TERMINAL_REQUIRED",
      "Use --recipient in an interactive terminal, or provide the recipient through MCP.",
    );
    const runtime = createRuntime();
    const reader = oneOff
      ? createInterface({ input: process.stdin, output: process.stdout })
      : undefined;
    try {
      const bank = reader ? await readBank(reader) : undefined;
      console.log(
        JSON.stringify(
          await runtime.service.prepare({
            amount: payoutId,
            currency: extra[0],
            ...(bank ? { bank } : {}),
          }),
          null,
          2,
        ),
      );
    } finally {
      reader?.close();
      runtime.close();
    }
    return;
  }
  if (command === "status" || command === "history") {
    requireThat(
      extra.length === 0 && (command === "status" ? Boolean(payoutId) : payoutId === undefined),
      "INVALID_COMMAND",
      "Use status <payout-id> or history.",
    );
    const runtime = createRuntime();
    try {
      console.log(
        JSON.stringify(
          command === "status"
            ? await runtime.service.status(payoutId!)
            : runtime.service.history(),
          null,
          2,
        ),
      );
    } finally {
      runtime.close();
    }
    return;
  }
  if (command === "--help" || command === "help") {
    console.log(
      [
        "Naira Offramp MCP",
        "Usage: naira-offramp-mcp [command]",
        "",
        "  serve                                      Run the stdio MCP server (default)",
        "  init                                       Create a private configuration file",
        "  doctor                                     Check local configuration",
        "  provider-check                             Check PAJ and wallet access",
        "  set-bank                                   Save an optional default recipient",
        "  quote <amount> <NGN|USDC> [--recipient]      Prepare an unfunded order",
        "  approve <payout-id>                         Review and approve a transfer",
        "  status <payout-id>                          Track an existing payout",
        "  history                                    List recent payouts",
        "  --version                                  Print the package version",
        "",
        "Transfers require human approval. NGN and network fees are estimates.",
      ].join("\n"),
    );
    return;
  }
  requireThat(
    !command || ["serve", "set-bank", "approve"].includes(command),
    "INVALID_COMMAND",
    "Unknown command. Run --help for supported commands.",
  );
  requireThat(
    extra.length === 0 && (command === "approve" ? Boolean(payoutId) : payoutId === undefined),
    "INVALID_COMMAND",
    "Use serve or set-bank without arguments, or approve <payout-id>.",
  );
  if (command === "set-bank" || command === "approve") {
    requireThat(
      process.stdin.isTTY && process.stdout.isTTY,
      "INTERACTIVE_TERMINAL_REQUIRED",
      "Human review requires an interactive terminal. Piped input is not accepted.",
    );
    const runtime = createRuntime();
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    const confirm = async (message: string) =>
      (await reader.question(`${message}\nType APPROVE to continue: `)) === "APPROVE";
    try {
      if (command === "set-bank") {
        console.log(
          JSON.stringify(
            await runtime.service.setDefaultBank(await readBank(reader), (account) =>
              confirm(
                `Save ${account.name}, ${account.bank}, ${account.accountNumber}? Verified with PAJ ${runtime.config.pajEnvironment}; stored locally for Arc ${runtime.config.arcNetwork}.`,
              ),
            ),
            null,
            2,
          ),
        );
      } else {
        console.log(
          JSON.stringify(
            await runtime.service.execute(payoutId!, (payout, bank) =>
              confirm(payoutApprovalMessage(payout, bank)),
            ),
            null,
            2,
          ),
        );
      }
    } finally {
      reader.close();
      runtime.close();
    }
    return;
  }
  const runtime = createRuntime();
  const server = createMcpServer(runtime.service, {
    readiness: () => inspectReadiness(runtime.config),
  });
  let closed = false;
  const shutdown = () => {
    if (!closed) {
      closed = true;
      runtime.close();
    }
  };
  server.server.onclose = shutdown;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void server.close().finally(shutdown);
    });
  }
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    shutdown();
    throw error;
  }
  // Protocol messages own stdout. Diagnostics and failures use stderr only.
}

main().catch((error) => {
  console.error(JSON.stringify(publicError(error)));
  process.exitCode = 1;
});
