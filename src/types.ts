export type Mode = "demo" | "live";
export interface BankInput { bank: string; accountNumber: string; expectedName: string }
export interface BankAccount {
  bankId: string; bankName: string; accountNumber: string; accountName: string;
  bankCode?: string;
}
export interface ProviderOrder {
  id: string; ngn: string; usdcUnits: string; depositAddress: string; expiresAt: string;
}
export interface ProviderStatus { status: string; completed: boolean }
export interface OfframpProvider {
  readonly name: string;
  readonly minimumNgn: bigint;
  readonly maximumNgn: bigint;
  verifyBank(input: BankInput): Promise<BankAccount>;
  rate(): Promise<bigint>; // NGN per USDC, scaled by 10^6.
  createOrder(bank: BankAccount, ngn: bigint): Promise<ProviderOrder>;
  checkOrder(order: ProviderOrder, bank: BankAccount): Promise<void>;
  status(order: ProviderOrder): Promise<ProviderStatus>;
}
export interface SettlementPlan {
  feeUnits: string; totalUnits: string; expiresAt: string;
  payload: Record<string, unknown>;
}
export interface SettlementResult { id: string }
export interface SettlementStatus { status: string; delivered: boolean }
export interface ArcSettlement {
  readonly name: string;
  balance(): Promise<{ walletUsdc: string; spendableUsdc: string }>;
  prepare(order: ProviderOrder): Promise<SettlementPlan>;
  validate(plan: SettlementPlan): Promise<void>;
  authorise(plan: SettlementPlan): Promise<Record<string, unknown>>;
  submit(authorisation: Record<string, unknown>): Promise<SettlementResult>;
  status(id: string): Promise<SettlementStatus>;
}
export type PayoutState = "prepared" | "authorising" | "submitting" | "settling" | "bank_pending" | "completed" | "reconciliation_required";
export interface Payout {
  id: string; mode: Mode; bank: BankAccount; order: ProviderOrder; plan: SettlementPlan;
  state: PayoutState; createdAt: string; expiresAt: string;
  requested: { amount: string; currency: "NGN" | "USDC" };
  settlementId?: string;
  settlementStatus?: string;
  providerStatus?: string;
}
export interface PayoutSummary {
  payoutId: string; mode: Mode; simulated: boolean; state: PayoutState;
  recipient: { name: string; bank: string; accountEnding: string };
  receiveNgn: string; providerChargeUsdc: string; settlementFeeMaximumUsdc: string;
  maximumDebitUsdc: string; source: "USDC on Arc"; expiresAt: string;
  bankPaid: boolean;
}
export type Approval = (summary: PayoutSummary, recipient: BankAccount) => Promise<boolean>;
