export type ReceiptKind = "funding" | "payout";
export type ArcReceiptStatus = "confirmed" | "pending" | "failed" | "mismatch" | "unavailable" | "not_recorded";

export interface ArcReceiptEvidence {
  status: ArcReceiptStatus;
  blockNumber?: string;
  blockHash?: string;
  confirmations?: string;
  timestamp?: string;
}

export interface ReceiptRecord {
  id: string;
  kind: ReceiptKind;
  providerOrderId: string;
  pajStatus: "COMPLETED";
  amountNgn: string;
  amountUsdc: string;
  walletAddress: string;
  timestamp: string;
  timestampSource: "Arc block" | "Completion observed" | "Order created";
  transactionHash?: string;
  explorerUrl?: string;
  arc: ArcReceiptEvidence;
  balanceBeforeUsdc?: string;
  balanceAfterUsdc?: string;
  balanceObservedAt?: string;
  recipient?: { name: string; bank: string; accountEnding: string };
}

export interface ReceiptArtifact {
  data: ReceiptRecord;
  text: string;
  svgPath: string;
}

export interface CachedReceipt {
  fingerprint: string;
  quality: number;
  data: ReceiptRecord;
}
