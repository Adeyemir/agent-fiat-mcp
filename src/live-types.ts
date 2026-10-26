import type { BankAccount } from "./types.js";
import type { PajOrder } from "./providers/paj.js";

export type LivePayoutState = "prepared" | "authorising" | "submitting" | "bank_pending" | "provider_completed" | "failed" | "reconciliation_required";
export interface LivePayout {
  id: string; state: LivePayoutState; bank: BankAccount; order: PajOrder;
  sourceAddress: string; createdAt: string; approvalExpiresAt: string;
  completedAt?: string; walletBalanceBeforeUsdc?: string;
  requested: { amount: string; currency: "NGN" | "USDC" };
  budgetUnits: string; feeReserveUnits: string; estimatedFeeUnits: string;
  circleTransactionId?: string; transactionHash?: string; providerStatus?: string;
  finalProviderNgn?: string;
  providerReceipt?: PajOrder;
}
export interface LivePayoutSummary {
  payoutId: string; mode: "live"; simulated: false; state: LivePayoutState;
  recipient: { name: string; bank: string; accountEnding: string };
  estimatedReceiveNgn: string; ngnAmountGuaranteed: false;
  providerChargeUsdc: string; estimatedNetworkFeeUsdc: string; estimatedTotalDebitUsdc: string;
  budgetUsdc: string; budgetBasis: "requested" | "configured_limit"; networkFeeReserveUsdc: string; networkFeeCapped: false;
  source: "USDC on Arc"; approvalExpiresAt: string;
  providerOrderId: string; circleTransactionId?: string;
  providerStatus?: string; finalProviderNgn?: string;
  providerTransferMatched: boolean;
  bankPaid: false; bankCreditIndependentlyVerified: false;
}
export type LiveApproval = (summary: LivePayoutSummary, bank: BankAccount) => Promise<boolean>;
