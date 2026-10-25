import { randomUUID } from "node:crypto";
import { CircleAgent } from "./adapters/circle.js";
import type { Config } from "./config.js";
import { OfframpError, publicError, requireThat } from "./errors.js";
import type { FundingOrder, FundingSummary } from "./funding-types.js";
import { jsonRequest } from "./http.js";
import { decimal, units } from "./money.js";
import { PajClient, PAJ_USDC, type JsonRequest, type PajOrder } from "./providers/paj.js";
import type { Store } from "./store.js";

export type FundingWallet = Pick<CircleAgent, "address" | "chain" | "checkVersion" | "requireAgentWallet">;

export class FundingService {
  constructor(readonly config: Config, private readonly store: Store, private readonly request: JsonRequest = jsonRequest, private readonly connectedWallet?: FundingWallet, private readonly now = () => Date.now()) {}

  private provider() { return new PajClient(this.config.pajEnvironment, this.config.pajApiKey, this.request); }

  private wallet(): FundingWallet {
    requireThat(this.config.arcAddress, "WALLET_SETUP_REQUIRED", "Configure the existing Circle Agent Wallet on Arc before preparing funding.");
    return this.connectedWallet ?? new CircleAgent(this.config.circleBin, this.config.arcAddress, this.config.arcNetwork);
  }

  private walletKey() {
    requireThat(this.config.mode === "live" && this.config.pajEnvironment === "production" && this.config.arcNetwork === "mainnet", "LIVE_NETWORK_UNVERIFIED", "PAJ naira funding is supported only for the existing Arc mainnet agent wallet in live production mode.");
    const wallet = this.wallet();
    requireThat(wallet.chain === "ARC" && wallet.address.toLowerCase() === this.config.arcAddress!.toLowerCase(), "FUNDING_WALLET_CHANGED", "The receiving wallet does not match the configured Arc mainnet agent wallet.");
    return `${this.config.pajEnvironment}:${this.config.arcNetwork}:${wallet.address.toLowerCase()}`;
  }

  private load(id: string) {
    const order = this.store.funding(id);
    requireThat(order.walletKey === this.walletKey(), "FUNDING_WALLET_CHANGED", "This funding order belongs to a different wallet or network. Do not pay its bank account from this profile.");
    return order;
  }

  async prepare(input: { amountNgn: string }): Promise<FundingSummary> {
    const amountUnits = units(input.amountNgn, 2);
    requireThat(amountUnits <= BigInt(Number.MAX_SAFE_INTEGER) && units(String(Number(input.amountNgn)), 2) === amountUnits, "INVALID_AMOUNT", "The naira amount cannot be sent exactly to PAJ.");
    const amountNgn = decimal(amountUnits, 2);
    const walletKey = this.walletKey();
    const wallet = this.wallet();
    await wallet.checkVersion();
    await wallet.requireAgentWallet();
    const existing = this.store.activeFunding(walletKey);
    if (existing) {
      requireThat(existing.amountNgn === amountNgn, "FUNDING_ORDER_ACTIVE", `Funding order ${existing.id} is still active. Check funding_status before creating another order.`);
      return this.status(existing.id);
    }
    await this.provider().requireActive("ARC");
    const record: FundingOrder = { id: randomUUID(), walletKey, walletAddress: wallet.address, amountNgn, state: "creating", createdAt: new Date(this.now()).toISOString() };
    if (!this.store.insertFunding(record)) {
      const active = this.store.activeFunding(walletKey);
      requireThat(active && active.amountNgn === amountNgn, "FUNDING_ORDER_ACTIVE", "Another funding order is already being prepared for this wallet. Inspect funding_history.");
      return this.status(active.id);
    }
    try {
      const order = await this.provider().createOnramp({ receiveAddress: wallet.address, chain: "ARC", spendNgn: amountNgn });
      const created = Date.parse(order.createdAt);
      const expiresAt = new Date(created + 72 * 60 * 60_000).toISOString();
      requireThat(created <= this.now() + 60_000 && Date.parse(expiresAt) > this.now(), "FUNDING_ORDER_EXPIRED", "PAJ returned expired or invalid bank payment instructions. Do not transfer naira.");
      record.order = order;
      record.expiresAt = expiresAt;
      record.providerStatus = order.status;
      record.state = "awaiting_fiat";
      requireThat(this.store.saveFunding(record, "creating"), "FUNDING_ORDER_CHANGED", "The local funding record changed. Reconcile the existing order before paying.");
      return this.summary(record);
    } catch (error) {
      const current = this.store.funding(record.id);
      if (current.state === "creating") {
        current.state = "creation_uncertain";
        current.lastErrorCode = publicError(error).code;
        this.store.saveFunding(current, "creating");
      }
      throw new OfframpError("FUNDING_CREATION_UNCERTAIN", `Funding request ${record.id} could not be confirmed. Do not retry creation or pay any bank details. Inspect funding_status and reconcile with PAJ using this local record.`);
    }
  }

  async status(id: string): Promise<FundingSummary> {
    const record = this.load(id);
    if (!record.order || ["provider_completed", "failed"].includes(record.state)) return this.summary(record);
    let provider: PajOrder;
    try { provider = await this.provider().transaction(record.order.id, "ON_RAMP"); }
    catch (error) {
      if (record.expiresAt && Date.parse(record.expiresAt) <= this.now()) {
        const previous = record.state;
        record.state = "reconciliation_required";
        record.lastErrorCode = publicError(error).code;
        this.store.saveFunding(record, previous);
      }
      throw error;
    }
    const bankMatches = (provider.accountNumber === undefined || provider.accountNumber === record.order.accountNumber)
      && (provider.bank === undefined || provider.bank === record.order.bank)
      && (provider.accountName === undefined || provider.accountName === record.order.accountName);
    const matches = provider.chain === "ARC" && provider.mint.toLowerCase() === PAJ_USDC.ARC.toLowerCase()
      && provider.recipient?.toLowerCase() === record.walletAddress.toLowerCase() && provider.ngn === record.amountNgn && bankMatches;
    if (!matches) {
      const previous = record.state;
      record.state = "reconciliation_required";
      record.lastErrorCode = "FUNDING_ORDER_CHANGED";
      this.store.saveFunding(record, previous);
      throw new OfframpError("FUNDING_ORDER_CHANGED", "PAJ returned different funding payment or receiving-wallet details. Reconcile this order; do not pay or create a replacement.");
    }
    const current = this.load(id);
    if (["provider_completed", "failed"].includes(current.state)) return this.summary(current);
    const previous = current.state;
    current.providerStatus = provider.status;
    current.state = provider.status === "COMPLETED" ? "provider_completed" : provider.status === "ERROR" ? "failed" : provider.status === "PROCESSING" ? "processing" : "awaiting_fiat";
    if (current.state === "awaiting_fiat" && current.expiresAt && Date.parse(current.expiresAt) <= this.now()) current.state = "expired";
    if (provider.status === "COMPLETED") {
      current.finalProviderUsdc = provider.usdc;
      if (provider.signature && /^0x[0-9a-f]{64}$/i.test(provider.signature)) current.transactionHash = provider.signature;
    }
    delete current.lastErrorCode;
    this.store.saveFunding(current, previous);
    return this.summary(this.load(id));
  }

  history() {
    return this.store.recentFunding(this.walletKey()).map(record => {
      const { bankPayment, ...summary } = this.summary(record);
      return { ...summary, ...(bankPayment ? { bank: bankPayment.bank, accountEnding: bankPayment.accountNumber.slice(-4) } : {}) };
    });
  }

  private summary(record: FundingOrder): FundingSummary {
    const bank = record.order;
    const instructionsAvailable = record.state === "awaiting_fiat" && record.expiresAt && Date.parse(record.expiresAt) > this.now();
    return {
      fundingId: record.id, mode: "live", simulated: false, state: record.state, amountNgn: record.amountNgn,
      recipient: { walletAddress: record.walletAddress, asset: "USDC", chain: "Arc", network: "mainnet" },
      receiveAmountGuaranteed: false, manualBankTransferRequired: true, walletCreditIndependentlyVerified: false,
      ...(bank ? { providerOrderId: bank.id, estimatedReceiveUsdc: bank.usdc } : {}),
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      ...(record.providerStatus ? { providerStatus: record.providerStatus } : {}),
      ...(record.finalProviderUsdc ? { finalProviderUsdc: record.finalProviderUsdc } : {}),
      ...(record.transactionHash ? { transactionHash: record.transactionHash } : {}),
      ...(record.lastErrorCode ? { lastErrorCode: record.lastErrorCode } : {}),
      ...(instructionsAvailable && bank?.accountNumber && bank.accountName && bank.bank ? { bankPayment: { bank: bank.bank, accountName: bank.accountName, accountNumber: bank.accountNumber, amountNgn: record.amountNgn, currency: "NGN" as const } } : {}),
    };
  }
}
