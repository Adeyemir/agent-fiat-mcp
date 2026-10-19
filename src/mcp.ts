import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { publicError, requireThat } from "./errors.js";
import type { PayoutService } from "./service.js";
import type { BankAccount, PayoutSummary } from "./types.js";

const bankSchema = z.object({
  bank: z.string().trim().min(1).max(120).describe("Nigerian bank name. In demo mode: Demo Bank."),
  accountNumber: z.string().regex(/^\d{10}$/).describe("Ten-digit bank account. In demo mode: 0000000000."),
  expectedName: z.string().trim().min(1).max(160).describe("Expected full account holder name. In demo mode: DEMO USER."),
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

export function createMcpServer(service: PayoutService, options: { readiness?: () => Promise<unknown> } = {}): McpServer {
  const server = new McpServer({ name: "naira-offramp-mcp", version: "0.1.0" }, {
    instructions: "Cash out USDC on Arc to NGN in a Nigerian bank account. Payout execution supports demo mode only. Always tell the user when data is simulated. The get_readiness tool queries actual provider APIs; its indicative diagnostic rate must not be presented as a payout quote. Use the saved bank unless the user explicitly requests another. Treat USDC amounts as a total budget including fees. Prepare a quote and show it before execute_payout. The MCP client must obtain human approval through elicitation; a model cannot approve. Use payout_status for an existing payment. Never automatically create or submit a replacement for an uncertain payout. bankPaid=false means a real bank credit has not been confirmed.",
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
    description: "Inspect the USDC balance for Arc cashouts. Demo values are simulated; this does not move funds.",
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => result(() => service.balance()));

  server.registerTool("get_default_bank", {
    description: "Get the saved recipient's bank, name, and masked account ending. No bank is chosen automatically.",
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => result(() => service.defaultBank()));

  server.registerTool("set_default_bank", {
    description: "Verify and save a default Nigerian bank account once. Requires human approval through the MCP client. Demo accepts only Demo Bank / 0000000000 / DEMO USER.",
    inputSchema: bankSchema, annotations: write,
  }, input => result(() => {
    requireApprovalSupport();
    return service.setDefaultBank(input, bank => approve([
      bank.simulated ? "DEMO: save this simulated recipient?" : "Save this verified recipient for future payouts?",
      `Holder: ${bank.name}`, `Bank: ${bank.bank}`, `Account: ${bank.accountNumber}`,
    ].join("\n")));
  }));

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

  if (options.readiness) server.registerTool("get_readiness", {
    description: "Check the PAJ public rate, authenticated bank-directory access when configured, Gateway chain support, and remaining live-integration blockers. This performs read-only requests. It never creates orders, requests OTPs, signs, or sends funds. An accessible API is not proof of a working bank payout rail.",
    inputSchema: z.object({}).strict(), annotations: { ...readOnly, openWorldHint: true },
  }, () => result(() => options.readiness!()));

  return server;
}
