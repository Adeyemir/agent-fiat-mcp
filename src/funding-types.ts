import type { PajOrder } from "./providers/paj.js";

export type FundingState = "creating" | "creation_uncertain" | "awaiting_fiat" | "processing" | "provider_completed" | "failed" | "expired" | "reconciliation_required";

export interface FundingOrder {
  id: string;
  revision?: number;
  walletKey: string;
  walletAddress: string;
  amountNgn: string;
  state: FundingState;
  createdAt: string;
  expiresAt?: string;
  order?: PajOrder;
  providerStatus?: string;
  finalProviderUsdc?: string;
  transactionHash?: string;
  lastErrorCode?: string;
}

export interface FundingSummary {
  fundingId: string;
  mode: "live";
  simulated: false;
  state: FundingState;
  amountNgn: string;
  recipient: { walletAddress: string; asset: "USDC"; chain: "Arc"; network: "mainnet" };
  estimatedReceiveUsdc?: string;
  receiveAmountGuaranteed: false;
  expiresAt?: string;
  providerOrderId?: string;
  providerStatus?: string;
  finalProviderUsdc?: string;
  transactionHash?: string;
  bankPayment?: { bank: string; accountName: string; accountNumber: string; amountNgn: string; currency: "NGN" };
  manualBankTransferRequired: true;
  walletCreditIndependentlyVerified: false;
  lastErrorCode?: string;
}
