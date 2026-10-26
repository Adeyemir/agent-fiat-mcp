import { createHash } from "node:crypto";
import { CircleAgent } from "./adapters/circle.js";
import { readArcReceipt, type ArcReceiptReader } from "./adapters/arc-receipt.js";
import type { Config } from "./config.js";
import { publicError, requireThat } from "./errors.js";
import { arcExplorerUrl, receiptId, saveReceipt } from "./receipt.js";
import type { ReceiptArtifact, ReceiptRecord } from "./receipt-types.js";
import type { Store } from "./store.js";
import { PAJ_USDC } from "./providers/paj.js";

export type ReceiptStatus<T> = Omit<T, "walletCreditIndependentlyVerified"> & { walletCreditIndependentlyVerified?: boolean; receipt?: ReceiptArtifact; receiptError?: ReturnType<typeof publicError> };

export class ReceiptService {
  constructor(private readonly config: Config, private readonly store: Store, private readonly options: { arc?: ArcReceiptReader; balance?: () => Promise<string>; now?: () => number } = {}) {}

  private source(id: string) {
    receiptId(id);
    requireThat(this.config.mode === "live" && this.config.arcNetwork === "mainnet" && this.config.pajEnvironment === "production" && this.config.arcAddress, "RECEIPT_UNAVAILABLE", "Real receipts require the configured Arc mainnet wallet and its live production profile.");
    const found = this.store.receiptOrder(id);
    const order = found.order;
    requireThat(order.state === "provider_completed" && order.providerStatus === "COMPLETED", "RECEIPT_NOT_READY", "This order has not reached PAJ-reported completion. Check its status; do not submit another payment.");
    const funding = found.kind === "funding" ? found.order : undefined;
    const payout = found.kind === "payout" ? found.order : undefined;
    const providerOrder = funding?.order ?? payout?.order;
    requireThat(providerOrder && providerOrder.currency === "NGN" && providerOrder.chain === "ARC" && providerOrder.mint.toLowerCase() === PAJ_USDC.ARC.toLowerCase(), "RECEIPT_EVIDENCE_MISSING", "The settled record does not identify the supported Arc USDC route.");
    const walletAddress = funding?.walletAddress ?? payout!.sourceAddress;
    requireThat(walletAddress.toLowerCase() === this.config.arcAddress.toLowerCase(), "RECEIPT_WALLET_CHANGED", "This receipt belongs to a different wallet. Use its original private profile.");
    if (funding) requireThat(funding.walletKey === `production:mainnet:${walletAddress.toLowerCase()}`, "RECEIPT_WALLET_CHANGED", "The receipt's wallet or source network differs from this profile.");
    const amountNgn = funding?.amountNgn ?? payout?.finalProviderNgn;
    const amountUsdc = funding?.finalProviderUsdc ?? payout?.order.usdc;
    requireThat(amountNgn && amountUsdc, "RECEIPT_EVIDENCE_MISSING", "The completed order lacks its final amounts. Reconcile the existing order before issuing a receipt.");
    const transactionHash = order.transactionHash;
    const base: ReceiptRecord = {
      id, kind: found.kind, providerOrderId: providerOrder.id, pajStatus: "COMPLETED", amountNgn, amountUsdc, walletAddress,
      timestamp: order.completedAt ?? order.createdAt, timestampSource: order.completedAt ? "Completion observed" : "Order created", arc: { status: "not_recorded" },
      ...(transactionHash ? { transactionHash, explorerUrl: arcExplorerUrl(transactionHash) } : {}),
      ...(order.walletBalanceBeforeUsdc !== undefined ? { balanceBeforeUsdc: order.walletBalanceBeforeUsdc } : {}),
      ...(payout ? { recipient: { name: payout.bank.accountName, bank: payout.bank.bankName, accountEnding: payout.bank.accountNumber.slice(-4) } } : {}),
    };
    const counterparty = payout?.order.depositAddress;
    const fingerprint = createHash("sha256").update(JSON.stringify({ base, counterparty })).digest("hex");
    return { base, counterparty, fingerprint };
  }

  async get(id: string): Promise<ReceiptArtifact> {
    const source = this.source(id);
    const cached = this.store.receipt(id);
    const prior = cached?.fingerprint === source.fingerprint ? cached.data : undefined;
    let data: ReceiptRecord = { ...source.base };
    if (prior?.arc.status === "confirmed") data = { ...prior };
    else if (data.transactionHash) {
      try {
        data.arc = await (this.options.arc ?? readArcReceipt)({ kind: data.kind, transactionHash: data.transactionHash, walletAddress: data.walletAddress, amountUsdc: data.amountUsdc, ...(source.counterparty ? { counterparty: source.counterparty } : {}) });
      } catch { data.arc = { status: "unavailable" }; }
      if (data.arc.status === "confirmed" && data.arc.timestamp) { data.timestamp = data.arc.timestamp; data.timestampSource = "Arc block"; }
    }
    if (prior?.balanceAfterUsdc !== undefined) {
      data.balanceAfterUsdc = prior.balanceAfterUsdc;
      if (prior.balanceObservedAt) data.balanceObservedAt = prior.balanceObservedAt;
    } else {
      try {
        const balance = this.options.balance ?? (async () => {
          const wallet = new CircleAgent(this.config.circleBin, source.base.walletAddress, "mainnet");
          await wallet.requireAgentWallet();
          return wallet.usdcBalance();
        });
        data.balanceAfterUsdc = await balance();
        data.balanceObservedAt = new Date((this.options.now ?? Date.now)()).toISOString();
      } catch { delete data.balanceAfterUsdc; }
    }
    const quality = (data.arc.status === "confirmed" ? 8 : data.arc.status === "unavailable" || data.arc.status === "not_recorded" ? 0 : 2) + (data.balanceAfterUsdc !== undefined ? 1 : 0);
    return this.store.transaction(() => {
      requireThat(this.source(id).fingerprint === source.fingerprint, "RECEIPT_ORDER_CHANGED", "The settled order changed while its receipt was being checked. Inspect the existing order.");
      const current = this.store.receipt(id);
      if (current?.fingerprint === source.fingerprint && current.quality >= quality) data = current.data;
      const artifact = saveReceipt(this.config.dataDir, data);
      this.store.saveReceipt(id, { fingerprint: source.fingerprint, quality: Math.max(current?.fingerprint === source.fingerprint ? current.quality : 0, quality), data });
      return artifact;
    });
  }

  async attach<T extends { state: string; fundingId?: string; payoutId?: string }>(status: T): Promise<ReceiptStatus<T>> {
    if (status.state !== "provider_completed") return status;
    const id = status.fundingId ?? status.payoutId;
    if (!id) return status;
    try {
      const receipt = await this.get(id);
      return { ...status, receipt, ...(status.fundingId ? { walletCreditIndependentlyVerified: receipt.data.arc.status === "confirmed" } : {}) };
    }
    catch (error) { return { ...status, receiptError: publicError(error) }; }
  }
}
