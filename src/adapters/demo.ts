import { randomUUID } from "node:crypto";
import { OfframpError, requireThat } from "../errors.js";
import { decimal, sameName } from "../money.js";
import type { ArcSettlement, BankAccount, BankInput, OfframpProvider, ProviderOrder, SettlementPlan } from "../types.js";

export class DemoProvider implements OfframpProvider {
  readonly name = "Simulated NGN provider";
  readonly minimumNgn = 100n;
  readonly maximumNgn = 5_000_000n;
  async verifyBank(input: BankInput): Promise<BankAccount> {
    requireThat(input.bank.toLowerCase() === "demo bank" && input.accountNumber === "0000000000", "DEMO_ACCOUNT_ONLY", "Demo mode uses Demo Bank, account 0000000000, holder DEMO USER. No real bank account is verified.");
    requireThat(sameName(input.expectedName, "DEMO USER"), "NAME_MISMATCH", "The simulated account holder is DEMO USER.");
    return { bankId: "demo", bankName: "Demo Bank", accountNumber: "0000000000", accountName: "DEMO USER" };
  }
  async rate() { return 1_500_000_000n; } // Explicitly fabricated: 1 USDC = NGN 1,500.
  async createOrder(_bank: BankAccount, ngn: bigint): Promise<ProviderOrder> {
    return { id: `demo-order-${randomUUID()}`, ngn: ngn.toString(), usdcUnits: ((ngn * 1_000_000n + 1499n) / 1500n + 100_000n).toString(), depositAddress: "demo-settlement-only", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
  }
  async checkOrder() {}
  async status() { return { status: "SIMULATED_COMPLETED", completed: true }; }
}

export class DemoSettlement implements ArcSettlement {
  readonly name = "Simulated Arc settlement";
  constructor(private readonly balanceUnits = 100_000_000n) {}
  async balance() { return { walletUsdc: decimal(this.balanceUnits), spendableUsdc: decimal(this.balanceUnits) }; }
  async prepare(order: ProviderOrder): Promise<SettlementPlan> {
    return { feeUnits: "50000", totalUnits: (BigInt(order.usdcUnits) + 50_000n).toString(), expiresAt: order.expiresAt, payload: { demo: true, orderId: order.id } };
  }
  async validate(plan: SettlementPlan) {
    requireThat(BigInt(plan.totalUnits) <= this.balanceUnits, "INSUFFICIENT_BALANCE", "The simulated Arc balance cannot cover this payout.");
  }
  async authorise(plan: SettlementPlan) { await this.validate(plan); return { ...plan.payload, demo: true }; }
  async submit(authorisation: Record<string, unknown>) {
    if (authorisation.demo !== true) throw new OfframpError("INVALID_DEMO", "A live authorisation cannot be submitted to the simulator.");
    return { id: `demo-settlement-${randomUUID()}` };
  }
  async status() { return { status: "SIMULATED_DELIVERED", delivered: true }; }
}
