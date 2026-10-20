import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { publicError, requireThat } from "./errors.js";
import type { PayoutService } from "./service.js";
import type { LiveService } from "./live-service.js";
import type { BankAccount, PayoutSummary } from "./types.js";

const bankSchema = z.object({
  bank: z.string().trim().min(1).max(120).describe("Exact Nigerian bank name or code from the bank directory."),
  accountNumber: z.string().regex(/^\d{10}$/).describe("Ten-digit bank account number."),
  expectedName: z.string().trim().min(1).max(160).describe("Expected full account holder name, checked against PAJ's resolved name."),
}).strict();
const idSchema = { payoutId: z.string().uuid().describe("The ID returned by prepare_payout; never create a replacement to retry a payment.") };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

async function result(action: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = { result: await action() };
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    const data = { error: publicError(error) };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  }
}

export function payoutApprovalMessage(payout: PayoutSummary, bank: BankAccount): string {
  return [
    payout.simulated ? "DEMO: simulated payout. No real money will move." : "Approve this bank payout.",
    `Payout ID: ${payout.payoutId}`,
    `Recipient: ${bank.accountName}; ${bank.bankName}; account ${bank.accountNumber}`,
    `Receive: NGN ${payout.receiveNgn}`,
    `Provider charge: ${payout.providerChargeUsdc} USDC`,
    `Maximum settlement fee: ${payout.settlementFeeMaximumUsdc} USDC`,
    `Maximum total debit: ${payout.maximumDebitUsdc} USDC on Arc`,
    `Quote expires: ${payout.expiresAt}`,
  ].join("\n");
}

export function createMcpServer(service: PayoutService | LiveService, options: { readiness?: () => Promise<unknown> } = {}): McpServer {
  const server = new McpServer({ name: "naira-offramp-mcp", version: "0.1.0" }, {
    instructions: service.mode === "demo"
      ? "Explicit simulator: balances, rates, quotes and payouts are fabricated. Always identify simulated results. For the simulated recipient use Demo Bank / 0000000000 / DEMO USER. Real API diagnostics from get_readiness do not fund simulated payouts. Use the saved bank unless another is explicitly requested. USDC amounts are a total budget including fees. Prepare a quote and obtain human approval through elicitation before execution. A model cannot approve. Never automatically resend an uncertain payment. bankPaid=false means actual bank credit has not been confirmed."
      : "Naira Offramp MCP uses real Circle Agent Wallet and PAJ APIs. get_balance reads actual USDC held on the configured Arc network; spendableUsdc=null means bank cashout availability is unknown, not zero. list_banks lists PAJ's Nigerian banks. set_default_bank verifies the exact account and full holder name with PAJ and, after human approval, saves the recipient locally for the selected provider environment and network. Use that saved recipient unless another is explicitly requested. Live Arc-to-NGN settlement is unfinished: no payout preparation or execution tools are available. Do not invent quotes, rates, balances or bank credits. get_readiness reports integration blockers and an indicative rate, which is not a payout quote. Never fall back to simulated payouts.",
    maxToolInputElements: 30,
  });

  function requireApprovalSupport() {
    const capabilities = server.server.getClientCapabilities()?.elicitation;
    requireThat(capabilities?.form, "HUMAN_APPROVAL_UNAVAILABLE", "This MCP client does not advertise form elicitation for human approval. Use a client that supports it, or review locally with the documented set-bank / approve CLI commands. A confirmed=true tool argument cannot approve a payout.");
  }

  async function approve(message: string): Promise<boolean> {
    requireApprovalSupport();
    const response = await server.server.elicitInput({
      mode: "form", message,
      requestedSchema: {
        type: "object", properties: { approve: { type: "boolean", title: "I approve the details shown above", default: false } }, required: ["approve"],
      },
    });
    return response.action === "accept" && response.content?.approve === true;
  }

  server.registerTool("get_balance", {
    description: service.mode === "demo" ? "Inspect the explicitly simulated USDC payout ledger. This does not read a real wallet." : "Read the real USDC balance in the configured Circle Agent Wallet on Arc. No simulated fallback. spendableUsdc is unknown until bank settlement is connected. Never moves funds.",
    inputSchema: z.object({}).strict(), annotations: { ...readOnly, openWorldHint: service.mode === "live" },
  }, () => result(() => service.balance()));

  server.registerTool("get_default_bank", {
    description: "Get the saved recipient's bank, name, and masked account ending. No bank is chosen automatically.",
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => result(() => service.defaultBank()));

  server.registerTool("set_default_bank", {
    description: service.mode === "demo" ? "Save a simulated recipient after human approval. Only Demo Bank / 0000000000 / DEMO USER is accepted." : "Verify a Nigerian bank account and full holder name with PAJ, request human approval, then save the default recipient locally. Does not create a PAJ order or send funds.",
    inputSchema: bankSchema, annotations: write,
  }, input => result(() => {
    requireApprovalSupport();
    return service.setDefaultBank(input, bank => approve([
      bank.simulated ? "DEMO: save this simulated recipient?" : "Save this verified recipient for future payouts?",
      `Holder: ${bank.name}`, `Bank: ${bank.bank}`, `Account: ${bank.accountNumber}`,
      ...("config" in service ? [`PAJ environment: ${service.config.pajEnvironment}`, `Arc source network: ${service.config.arcNetwork}`, "The verified recipient will be saved locally. No payout will be created."] : []),
    ].join("\n")));
  }));

  if ("banks" in service) server.registerTool("list_banks", {
    description: "Read the authenticated PAJ Nigerian bank directory for recipient setup. Returns bank names, codes and IDs; never moves funds.",
    inputSchema: z.object({}).strict(), annotations: { ...readOnly, openWorldHint: true },
  }, () => result(() => service.banks()));

  if (options.readiness) server.registerTool("get_readiness", {
    description: "Check real Arc wallet USDC and Arc Gateway deposit balances when configured, PAJ public rate, authenticated bank-directory access, Gateway chain support, and remaining live-integration blockers. This performs read-only requests. It never creates orders, requests OTPs, signs, or sends funds. An accessible API is not proof of a working bank payout rail.",
    inputSchema: z.object({}).strict(), annotations: { ...readOnly, openWorldHint: true },
  }, () => result(() => options.readiness!()));

  // Payment tools are only registered for the explicitly selected simulator.
  // LiveService deliberately has no payment methods to accidentally call.
  if (!("prepare" in service)) return server;

  server.registerTool("prepare_payout", {
    description: "Prepare a quote; no funds move. NGN means exact naira to receive; USDC means maximum total spend including all fees. Defaults to the saved bank. Supply a bank only when the user explicitly requests another destination. Repeated calls create separate quotes.",
    inputSchema: z.object({
      amount: z.string().max(30).regex(/^(0|[1-9]\d*)(\.\d+)?$/).describe("Positive decimal text, e.g. 15000 or 10. Never use floating point numbers."),
      currency: z.enum(["NGN", "USDC"]),
      bank: bankSchema.optional(),
    }).strict(), annotations: { ...write, destructiveHint: false },
  }, input => result(() => service.prepare({ amount: input.amount, currency: input.currency, ...(input.bank ? { bank: input.bank } : {}) })));

  server.registerTool("execute_payout", {
    description: "Request human approval for the exact prepared quote, then execute it at most once. Never claims bank credit from a chain receipt alone. Repeated calls inspect the existing payout; uncertain submissions require reconciliation and must not be resent.",
    inputSchema: z.object(idSchema).strict(), annotations: { ...write, idempotentHint: true },
  }, ({ payoutId }) => result(() => service.execute(payoutId, (payout, bank) => approve(payoutApprovalMessage(payout, bank)))));

  server.registerTool("payout_status", {
    description: "Inspect an existing payout. Reports completed only after the payout provider confirms completion. A demo completion is simulated and always has bankPaid=false. Never sends funds.",
    inputSchema: z.object(idSchema).strict(), annotations: { ...readOnly, openWorldHint: true },
  }, ({ payoutId }) => result(() => service.status(payoutId)));

  server.registerTool("payout_history", {
    description: "List the ten most recent payouts in this local mode/profile. Bank account numbers are masked.",
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => result(() => service.history()));

  return server;
}
