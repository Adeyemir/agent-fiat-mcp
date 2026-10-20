import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { publicError, requireThat } from "./errors.js";
import { packageInfo } from "./package-info.js";
import type { LiveService } from "./live-service.js";
import type { LivePayoutSummary } from "./live-types.js";
import type { BankAccount } from "./types.js";

const bankSchema = z
  .object({
    bank: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("Exact Nigerian bank name or code from the bank directory."),
    accountNumber: z
      .string()
      .regex(/^\d{10}$/)
      .describe("Ten-digit bank account number."),
    expectedName: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .describe("Expected full account holder name, checked against PAJ's resolved name."),
  })
  .strict();
const idSchema = {
  payoutId: z
    .string()
    .uuid()
    .describe("The ID returned by prepare_payout; never create a replacement to retry a payment."),
};
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const write = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

async function result(action: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = { result: await action() };
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    const data = { error: publicError(error) };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    };
  }
}

export function payoutApprovalMessage(payout: LivePayoutSummary, bank: BankAccount): string {
  return [
    "Approve this real USDC on Arc → NGN payout.",
    `Payout ID: ${payout.payoutId}`,
    `Recipient: ${bank.accountName}; ${bank.bankName}; account ${bank.accountNumber}`,
    `Estimated receive: NGN ${payout.estimatedReceiveNgn}. PAJ applies the rate when it observes the deposit; this NGN amount is not guaranteed.`,
    `USDC sent to PAJ: ${payout.providerChargeUsdc}`,
    `Estimated network fee: ${payout.estimatedNetworkFeeUsdc} USDC`,
    `Estimated total debit: ${payout.estimatedTotalDebitUsdc} USDC`,
    `${payout.budgetBasis === "requested" ? "Requested USDC budget" : "Configured estimated USDC spending limit"}: ${payout.budgetUsdc}; fee reserve: ${payout.networkFeeReserveUsdc} USDC. The reserve is retained in your wallet for gas, not an extra PAJ charge.`,
    "Circle's CLI does not expose a hard network-fee cap. Actual network fees can vary; the total budget is checked against estimates before submission, not guaranteed on-chain.",
    `Local approval expires: ${payout.approvalExpiresAt}. This is not a rate lock.`,
  ].join("\n");
}

export function createMcpServer(
  service: LiveService,
  options: { readiness?: () => Promise<unknown> } = {},
): McpServer {
  const server = new McpServer(packageInfo, {
    instructions:
      "Pay Nigerian bank accounts from Circle Agent Wallet USDC on Arc. Use an explicitly requested recipient or optional saved default. Prepare an unfunded quote, show all recipient, NGN and fee terms, then obtain human elicitation approval before execution. Never resend an uncertain transfer or create a replacement for it. Track existing orders with payout_status. NGN and gas are estimates; Circle's CLI does not hard-cap gas. A USDC request is a budget with a retained gas reserve. PAJ applies its rate when it observes the deposit. provider_completed means PAJ reports completion; bank credit is not automatically observed. Service discovery, booking and merchant fulfilment require separate tools.",
    maxToolInputElements: 30,
  });

  function requireApprovalSupport() {
    const capabilities = server.server.getClientCapabilities()?.elicitation;
    requireThat(
      capabilities?.form,
      "HUMAN_APPROVAL_UNAVAILABLE",
      "This MCP client does not advertise form elicitation for human approval. Use a client that supports it, or review locally with the documented set-bank / approve CLI commands. A confirmed=true tool argument cannot approve a payout.",
    );
  }

  async function approve(message: string): Promise<boolean> {
    requireApprovalSupport();
    const response = await server.server.elicitInput({
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: {
          approve: { type: "boolean", title: "I approve the details shown above", default: false },
        },
        required: ["approve"],
      },
    });
    return response.action === "accept" && response.content?.approve === true;
  }

  server.registerTool(
    "get_balance",
    {
      description:
        "Read USDC held in the Circle Agent Wallet on Arc. Payout spendability depends on the order and network fee. Never moves funds.",
      inputSchema: z.object({}).strict(),
      annotations: { ...readOnly, openWorldHint: true },
    },
    () => result(() => service.balance()),
  );

  server.registerTool(
    "get_default_bank",
    {
      description:
        "Get the saved recipient's bank, name, and masked account ending. No bank is chosen automatically.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    () => result(() => service.defaultBank()),
  );

  server.registerTool(
    "set_default_bank",
    {
      description:
        "Verify a Nigerian bank account and full holder name with PAJ, then request human approval to save it as the local default. Registration remains at PAJ if local saving is declined. Never funds an order.",
      inputSchema: bankSchema,
      annotations: write,
    },
    (input) =>
      result(() => {
        requireApprovalSupport();
        return service.setDefaultBank(input, (bank) =>
          approve(
            [
              "Save this verified recipient for future payouts?",
              `Holder: ${bank.name}`,
              `Bank: ${bank.bank}`,
              `Account: ${bank.accountNumber}`,
              `PAJ environment: ${service.config.pajEnvironment}`,
              `Arc source network: ${service.config.arcNetwork}`,
            ].join("\n"),
          ),
        );
      }),
  );

  server.registerTool(
    "list_banks",
    {
      description:
        "Read the authenticated PAJ Nigerian bank directory for recipient setup. Returns bank names, codes and IDs; never moves funds.",
      inputSchema: z.object({}).strict(),
      annotations: { ...readOnly, openWorldHint: true },
    },
    () => result(() => service.banks()),
  );

  if (options.readiness)
    server.registerTool(
      "get_readiness",
      {
        description:
          "Check PAJ rates, bank access, active Arc support and the authenticated Circle Agent Wallet. Never registers banks, creates orders or moves funds.",
        inputSchema: z.object({}).strict(),
        annotations: { ...readOnly, openWorldHint: true },
      },
      () => result(() => options.readiness!()),
    );

  server.registerTool(
    "prepare_payout",
    {
      description:
        "Verify the specified recipient or use the saved default, then create an unfunded PAJ Arc order. NGN is an estimated receive target; USDC is a budget including estimated gas with a retained reserve. Repeated calls create separate orders. Never prepare a replacement for an uncertain transfer.",
      inputSchema: z
        .object({
          amount: z
            .string()
            .max(30)
            .regex(/^(0|[1-9]\d*)(\.\d+)?$/)
            .describe("Positive decimal text, e.g. 15000 or 10. Never use floating point numbers."),
          currency: z.enum(["NGN", "USDC"]),
          bank: bankSchema.optional(),
        })
        .strict(),
      annotations: { ...write, destructiveHint: false },
    },
    (input) =>
      result(() =>
        service.prepare({
          amount: input.amount,
          currency: input.currency,
          ...(input.bank ? { bank: input.bank } : {}),
        }),
      ),
  );

  server.registerTool(
    "execute_payout",
    {
      description:
        "Obtain human approval of the prepared recipient, payment, indicative NGN and fee terms, recheck the existing order and fee, then transfer Arc USDC once. Repeated execution only inspects status; uncertain submissions require reconciliation and must not be resent.",
      inputSchema: z.object(idSchema).strict(),
      annotations: { ...write, idempotentHint: true },
    },
    ({ payoutId }) =>
      result(() =>
        service.execute(payoutId, (payout, bank) => approve(payoutApprovalMessage(payout, bank))),
      ),
  );

  server.registerTool(
    "payout_status",
    {
      description:
        "Poll an existing payout without sending funds. PAJ COMPLETED becomes provider_completed with the final NGN amount. A matching transfer receipt does not automatically verify bank credit. ERROR reports failed with no automatic retry or refund.",
      inputSchema: z.object(idSchema).strict(),
      annotations: { ...readOnly, openWorldHint: true },
    },
    ({ payoutId }) => result(() => service.status(payoutId)),
  );

  server.registerTool(
    "payout_history",
    {
      description:
        "List the ten most recent payouts in this local profile, with masked account numbers.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    () => result(() => service.history()),
  );

  return server;
}
