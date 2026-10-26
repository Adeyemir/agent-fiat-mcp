import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { publicError, requireThat } from "./errors.js";
import type { PayoutService } from "./service.js";
import type { LiveService } from "./live-service.js";
import type { LivePayoutSummary } from "./live-types.js";
import type { BankAccount, PayoutSummary } from "./types.js";
import type { FundingService } from "./funding-service.js";
import type { ReceiptService } from "./receipt-service.js";

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
    const value = data.result;
    const candidate = value && typeof value === "object" && "receipt" in value ? value.receipt : value;
    const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(data) }];
    if (candidate && typeof candidate === "object" && "text" in candidate && typeof candidate.text === "string" && "svgPath" in candidate && typeof candidate.svgPath === "string") content.push({ type: "text", text: `${candidate.text}\nSVG receipt: ${candidate.svgPath}` });
    return { content, structuredContent: data };
  } catch (error) {
    const data = { error: publicError(error) };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  }
}

export function payoutApprovalMessage(payout: PayoutSummary | LivePayoutSummary, bank: BankAccount): string {
  if ("estimatedReceiveNgn" in payout) return [
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

export function createMcpServer(service: PayoutService | LiveService, options: { readiness?: () => Promise<unknown>; funding?: FundingService; receipts?: ReceiptService } = {}): McpServer {
  const server = new McpServer({ name: "agent-fiat-mcp", version: "0.3.0" }, {
    instructions: service.mode === "demo"
      ? "Explicit simulator: balances, rates, quotes and payouts are fabricated. Always identify simulated results. For the simulated recipient use Demo Bank / 0000000000 / DEMO USER. Real API diagnostics from get_readiness do not fund simulated payouts. Use the saved bank unless another is explicitly requested. USDC amounts are a total budget including fees. Prepare a quote and obtain human approval through elicitation before execution. A model cannot approve. Never automatically resend an uncertain payment. bankPaid=false means actual bank credit has not been confirmed."
      : "Real Circle Agent Wallet and PAJ v2 integration for USDC on Arc to NGN. Authenticate PAJ with its local Business API key; no PAJ OTP session is needed. get_balance reads actual Arc USDC; spendableUsdc=null is unknown, not zero. set_default_bank registers/verifies the account with PAJ, checks the full holder name and obtains human approval to save locally. Use the saved recipient unless another is explicitly requested. prepare_payout creates a one-off Arc order. NGN is an estimated target, never guaranteed: PAJ settles at the rate when the deposit is observed. A USDC request budgets transfer plus estimated gas and retains a fee reserve; actual gas is not hard-capped by the Circle CLI, so never promise a guaranteed total debit. Show the complete quote and obtain human elicitation approval before execute_payout. Never automatically resend an uncertain payment or create a replacement payout for it. Provider COMPLETED is reported as provider_completed; bankPaid=false because bank credit has not been independently verified. Use payout_status to track an existing order. This direct Arc route does not use Gateway or a Solana standing address. Never fall back to simulation." + (options.funding ? " For NGN funding, prepare_funding returns a one-time bank account bound to the existing authenticated Arc wallet. The person reviews and pays from their banking app; the tool never debits fiat. Track the same fundingId with funding_status. Never pay stale instructions or create a replacement for uncertain creation. Provider-reported completion alone is not independently verified wallet credit." : "") + (options.receipts ? " Completed status results include a text receipt and a local SVG path. Show these to the person, preserving missing or unverified evidence labels. get_receipt retrieves either completed order by its local ID. Arc verification establishes the expected USDC transfer, never recipient bank credit. A receiptError does not reverse completion or justify another payment." : ""),
    maxToolInputElements: 30,
  });

  async function withReceipt<T extends { state: string; fundingId?: string; payoutId?: string }>(action: () => Promise<T>) {
    const status = await action();
    return options.receipts ? options.receipts.attach(status) : status;
  }

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
    description: service.mode === "demo" ? "Inspect the explicitly simulated USDC payout ledger. This does not read a real wallet." : "Read real USDC held in the Circle Agent Wallet on Arc. Payout spendability depends on the provider order and estimated network fee. Never moves funds.",
    inputSchema: z.object({}).strict(), annotations: { ...readOnly, openWorldHint: service.mode === "live" },
  }, () => result(() => service.balance()));

  server.registerTool("get_default_bank", {
    description: "Get the saved recipient's bank, name, and masked account ending. No bank is chosen automatically.",
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => result(() => service.defaultBank()));

  server.registerTool("set_default_bank", {
    description: service.mode === "demo" ? "Save a simulated recipient after human approval. Only Demo Bank / 0000000000 / DEMO USER is accepted." : "Register/verify a Nigerian bank account and full holder name with PAJ v2, request human approval, then save locally. Registration creates a provider record even if local saving is declined. Never funds an order. Its returned Solana standing address is not used for Arc payouts.",
    inputSchema: bankSchema, annotations: write,
  }, input => result(() => {
    requireApprovalSupport();
    return service.setDefaultBank(input, bank => approve([
      bank.simulated ? "DEMO: save this simulated recipient?" : "Save this verified recipient for future payouts?",
      `Holder: ${bank.name}`, `Bank: ${bank.bank}`, `Account: ${bank.accountNumber}`,
      ...("config" in service ? [`PAJ environment: ${service.config.pajEnvironment}`, `Arc source network: ${service.config.arcNetwork}`, "PAJ has registered/verified this account. Approve saving it locally for future Arc orders."] : []),
    ].join("\n")));
  }));

  if ("banks" in service) server.registerTool("list_banks", {
    description: "Read the authenticated PAJ Nigerian bank directory for recipient setup. Returns bank names, codes and IDs; never moves funds.",
    inputSchema: z.object({}).strict(), annotations: { ...readOnly, openWorldHint: true },
  }, () => result(() => service.banks()));

  if (options.readiness) server.registerTool("get_readiness", {
    description: "Read PAJ v2 rates, bank access and current Arc availability using the Business API key; inspect the Circle wallet and optional Gateway deposit balance. Gateway is not required for direct Arc orders. Never registers banks, creates orders or moves funds. Read access does not prove bank delivery.",
    inputSchema: z.object({}).strict(), annotations: { ...readOnly, openWorldHint: true },
  }, () => result(() => options.readiness!()));

  server.registerTool("prepare_payout", {
    description: service.mode === "demo" ? "Prepare a simulated payout quote. NGN is exact simulated receive and USDC is the simulated total budget." : "Create a fresh PAJ Arc order; no funds move. NGN is an estimated receive target. USDC budgets payment plus estimated network fees with a retained reserve; gas is not hard-capped. Uses the saved bank unless another is explicitly requested. Repeated calls create separate provider orders. Never use an old order address or prepare a replacement for an uncertain payment.",
    inputSchema: z.object({
      amount: z.string().max(30).regex(/^(0|[1-9]\d*)(\.\d+)?$/).describe("Positive decimal text, e.g. 15000 or 10. Never use floating point numbers."),
      currency: z.enum(["NGN", "USDC"]),
      bank: bankSchema.optional(),
    }).strict(), annotations: { ...write, destructiveHint: false },
  }, input => result(() => service.prepare({ amount: input.amount, currency: input.currency, ...(input.bank ? { bank: input.bank } : {}) })));

  server.registerTool("execute_payout", {
    description: "Obtain human approval of the prepared recipient, payment, indicative NGN and fee terms, re-check the existing order and fee, then submit once. Real mode transfers Arc USDC through Circle Agent Wallet. Repeated execution only inspects status; uncertain submissions require reconciliation and must not be resent.",
    inputSchema: z.object(idSchema).strict(), annotations: { ...write, idempotentHint: true },
  }, ({ payoutId }) => result(() => withReceipt(async () => service.execute(payoutId, (payout, bank) => approve(payoutApprovalMessage(payout, bank))))));

  server.registerTool("payout_status", {
    description: "Poll an existing payout without sending funds. Live provider COMPLETED becomes provider_completed and includes the provider's final NGN amount; bankPaid remains false until independent bank-credit evidence exists. When receipt support is configured, completed results include a text receipt and local SVG path with separate Arc evidence. ERROR reports failed with no automatic retry or refund. Demo completion remains explicitly simulated.",
    inputSchema: z.object(idSchema).strict(), annotations: { ...readOnly, openWorldHint: true },
  }, ({ payoutId }) => result(() => withReceipt(async () => service.status(payoutId))));

  server.registerTool("payout_history", {
    description: "List the ten most recent payouts in this local mode/profile. Bank account numbers are masked.",
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => result(() => service.history()));

  if (options.funding) {
    const funding = options.funding;
    server.registerTool("prepare_funding", {
      description: "Prepare naira funding of the existing authenticated Circle Agent Wallet on Arc through PAJ. Creates an unfunded virtual-bank-account order and returns the exact naira amount and estimated USDC. Reuses an active order for the same amount; never creates a replacement for uncertain creation. Show the complete receiving wallet, bank account, amount and expiry. The person must review and pay from their banking app; this tool never debits fiat or transfers USDC. Never pay expired instructions.",
      inputSchema: z.object({ amountNgn: z.string().max(30).regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/).describe("Positive naira amount as decimal text. The receiving Arc wallet comes from private configuration.") }).strict(),
      annotations: { ...write, destructiveHint: false },
    }, input => result(() => withReceipt(() => funding.prepare(input))));
    server.registerTool("funding_status", {
      description: "Poll the existing funding order without moving money. Only a returned bankPayment contains current payable instructions; if absent, do not request another payment or invent an account. PAJ COMPLETED means provider-reported USDC delivery. When receipt support is configured, completed results include a text receipt and local SVG path; walletCreditIndependentlyVerified is true only after checking the matching Arc USDC credit. Preserve unverified labels when evidence is missing. Never pay again or create a replacement for an uncertain or mismatched order.",
      inputSchema: z.object({ fundingId: z.string().uuid().describe("The local ID returned by prepare_funding.") }).strict(),
      annotations: { ...readOnly, openWorldHint: true },
    }, ({ fundingId }) => result(() => withReceipt(() => funding.status(fundingId))));
    server.registerTool("funding_history", {
      description: "Inspect the ten latest local funding orders for the configured wallet. Bank account numbers are masked. Never creates an order or moves money.",
      inputSchema: z.object({}).strict(), annotations: readOnly,
    }, () => result(() => funding.history()));
  }

  if (options.receipts) server.registerTool("get_receipt", {
    description: "Generate the deterministic text receipt and private local SVG for an existing completed funding or payout ID. Includes PAJ status, observed balance change when recorded, Arc transfer verification and its explorer link. Show the receipt text and SVG path to the person, preserving unverified labels. Provider completion is not independent bank-credit proof. May perform read-only chain and wallet checks and write local receipt files; never creates an order or moves money.",
    inputSchema: z.object({ id: z.string().uuid().describe("The local fundingId or payoutId of the completed order.") }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ id }) => result(() => options.receipts!.get(id)));

  return server;
}
