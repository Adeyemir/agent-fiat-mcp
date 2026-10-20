import { CircleAgent } from "./adapters/circle.js";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { OfframpError, requireThat } from "./errors.js";
import { jsonRequest } from "./http.js";
import type { JsonRequest } from "./providers/paj.js";
import { createProvider } from "./providers/index.js";
import type { Store } from "./store.js";
import type { BankApproval, BankInput } from "./types.js";
import { decimal, units } from "./money.js";
import type { LiveApproval, LivePayout, LivePayoutSummary } from "./live-types.js";

export type LiveWallet = Pick<
  CircleAgent,
  | "address"
  | "chain"
  | "checkVersion"
  | "usdcBalance"
  | "requireAgentWallet"
  | "estimateUsdcTransfer"
  | "transferUsdc"
>;

export class LiveService {
  readonly mode = "live" as const;
  private readonly bankScope: string;

  constructor(
    readonly config: Config,
    private readonly store: Store,
    private readonly request: JsonRequest = jsonRequest,
    private readonly connectedWallet?: LiveWallet,
    private readonly now = () => Date.now(),
  ) {
    this.bankScope = `live:${config.pajEnvironment}:${config.arcNetwork}`;
  }

  private provider() {
    return createProvider(this.config, this.request);
  }

  private wallet(): LiveWallet {
    requireThat(
      this.config.arcAddress,
      "WALLET_SETUP_REQUIRED",
      "Connect your Circle Agent Wallet and save its Arc address in local configuration.",
    );
    return (
      this.connectedWallet ??
      new CircleAgent(this.config.circleBin, this.config.arcAddress, this.config.arcNetwork)
    );
  }

  private requireProduction() {
    requireThat(
      this.config.pajEnvironment === "production" && this.config.arcNetwork === "mainnet",
      "LIVE_NETWORK_UNVERIFIED",
      "The documented PAJ v2 Arc route uses production mainnet. Testnet funds must not be sent to it.",
    );
  }

  async balance() {
    const wallet = this.wallet();
    await wallet.checkVersion();
    return {
      mode: this.mode,
      simulated: false,
      source: "USDC on Arc",
      network: this.config.arcNetwork,
      walletUsdc: await wallet.usdcBalance(),
      spendableUsdc: null,
    };
  }

  async banks() {
    return {
      mode: this.mode,
      simulated: false,
      provider: "PAJ",
      environment: this.config.pajEnvironment,
      banks: await this.provider().banks(),
    };
  }

  defaultBank() {
    const bank = this.store.getBank(this.bankScope);
    return bank
      ? {
          mode: this.mode,
          simulated: false,
          environment: this.config.pajEnvironment,
          name: bank.accountName,
          bank: bank.bankName,
          accountEnding: bank.accountNumber.slice(-4),
        }
      : null;
  }

  async setDefaultBank(input: BankInput, approve: BankApproval) {
    const bank = await this.provider().verifyBank(input);
    requireThat(
      await approve({
        name: bank.accountName,
        bank: bank.bankName,
        accountNumber: bank.accountNumber,
      }),
      "APPROVAL_REQUIRED",
      "The default bank account was not changed.",
    );
    // V2 registration has verified the bank. Store its code, not its Solana
    // standing address, for future direct Arc orders.
    this.store.setBank(this.bankScope, bank);
    return {
      mode: this.mode,
      simulated: false,
      name: bank.accountName,
      bank: bank.bankName,
      accountEnding: bank.accountNumber.slice(-4),
    };
  }

  async prepare(input: {
    amount: string;
    currency: "NGN" | "USDC";
    bank?: BankInput;
  }): Promise<LivePayoutSummary> {
    this.requireProduction();
    requireThat(
      input.currency === "NGN" || input.currency === "USDC",
      "UNSUPPORTED_CURRENCY",
      "Use NGN or USDC.",
    );
    const requested = units(input.amount, input.currency === "NGN" ? 2 : 6);
    const budget = input.currency === "USDC" ? requested : this.config.maximumUnits;
    requireThat(
      budget <= this.config.maximumUnits && budget > this.config.networkFeeReserveUnits,
      "PAYOUT_LIMIT",
      "The USDC budget must fit the configured limit and leave room for the network fee reserve.",
    );
    const bank = input.bank
      ? await this.provider().verifyBank(input.bank)
      : this.store.getBank(this.bankScope);
    requireThat(
      bank,
      "DEFAULT_BANK_REQUIRED",
      "Verify and save your default bank, or explicitly specify a recipient.",
    );
    requireThat(
      bank.bankCode,
      "DEFAULT_BANK_REVERIFY_REQUIRED",
      "Re-verify the saved recipient with PAJ v2 to obtain its bank code.",
    );
    const wallet = this.wallet();
    await wallet.checkVersion();
    await wallet.requireAgentWallet();
    const order = await this.provider().createOfframp({
      bankCode: bank.bankCode,
      accountNumber: bank.accountNumber,
      ...(input.currency === "USDC"
        ? { usdc: decimal(budget - this.config.networkFeeReserveUnits) }
        : { receiveNgn: decimal(requested, 2) }),
    });
    const created = Date.parse(order.createdAt);
    const approvalExpiresAt = new Date(
      Math.min(this.now() + 5 * 60_000, created + 2 * 60 * 60_000 - 60_000),
    ).toISOString();
    requireThat(
      created <= this.now() + 60_000 && Date.parse(approvalExpiresAt) > this.now(),
      "QUOTE_EXPIRED",
      "PAJ returned a stale or invalid funding address. Do not fund it.",
    );
    const estimatedFee = await wallet.estimateUsdcTransfer(order.depositAddress, order.usdc);
    const payout: LivePayout = {
      id: randomUUID(),
      state: "prepared",
      bank,
      order,
      sourceAddress: wallet.address,
      createdAt: new Date(this.now()).toISOString(),
      approvalExpiresAt,
      requested: { amount: input.amount, currency: input.currency },
      budgetUnits: budget.toString(),
      feeReserveUnits: this.config.networkFeeReserveUnits.toString(),
      estimatedFeeUnits: this.feeUnits(estimatedFee).toString(),
    };
    await this.checkFunds(payout, wallet, estimatedFee);
    this.store.insertLive(payout);
    return this.summary(payout);
  }

  private feeUnits(value: string): bigint {
    return value === "0" ? 0n : units(value);
  }

  private async checkFunds(payout: LivePayout, wallet: LiveWallet, estimatedFee?: string) {
    const fee = this.feeUnits(
      estimatedFee ??
        (await wallet.estimateUsdcTransfer(payout.order.depositAddress, payout.order.usdc)),
    );
    const charge = units(payout.order.usdc);
    requireThat(
      fee <= BigInt(payout.feeReserveUnits) &&
        charge + fee <= BigInt(payout.budgetUnits) &&
        charge + fee <= this.config.maximumUnits,
      "NETWORK_FEE_CHANGED",
      "The current estimated fee exceeds the prepared budget or reserve. Prepare a new payout for human review.",
    );
    const balance = await wallet.usdcBalance();
    requireThat(
      balance !== "0" && charge + BigInt(payout.feeReserveUnits) <= units(balance),
      "INSUFFICIENT_BALANCE",
      "The Arc wallet cannot cover the USDC transfer and the network fee reserve.",
    );
    payout.estimatedFeeUnits = fee.toString();
  }

  private load(id: string): LivePayout {
    const payout = this.store.live(id);
    requireThat(
      payout.sourceAddress.toLowerCase() === this.wallet().address.toLowerCase(),
      "PAYMENT_SOURCE_CHANGED",
      "This payout belongs to a different Arc wallet. Do not fund it from the current wallet.",
    );
    return payout;
  }

  async execute(id: string, approve: LiveApproval): Promise<LivePayoutSummary> {
    this.requireProduction();
    const payout = this.load(id);
    if (payout.state !== "prepared") return this.status(id);
    const unexpired = () =>
      requireThat(
        Date.parse(payout.approvalExpiresAt) > this.now(),
        "QUOTE_EXPIRED",
        "The local approval window expired. The PAJ funding address must not be reused.",
      );
    unexpired();
    const wallet = this.wallet();
    await wallet.requireAgentWallet();
    await this.provider().checkOrder(payout.order);
    await this.checkFunds(payout, wallet);
    requireThat(
      await approve(this.summary(payout), payout.bank),
      "APPROVAL_REQUIRED",
      "The payout was not approved. No funds were sent.",
    );
    unexpired();
    payout.state = "authorising";
    if (!this.store.saveLive(payout, "prepared")) return this.status(id);
    try {
      await this.provider().checkOrder(payout.order);
      await this.checkFunds(payout, wallet);
      unexpired();
    } catch (error) {
      payout.state = "prepared";
      this.store.saveLive(payout, "authorising");
      throw error;
    }
    payout.state = "submitting";
    requireThat(
      this.store.saveLive(payout, "authorising"),
      "PAYOUT_ALREADY_CLAIMED",
      "This payout is already being processed. Inspect its status.",
    );
    try {
      const transfer = await wallet.transferUsdc(
        payout.order.depositAddress,
        payout.order.usdc,
        payout.id,
      );
      payout.circleTransactionId = transfer.id;
      if (transfer.txHash) payout.transactionHash = transfer.txHash;
      payout.state = "bank_pending";
      this.store.saveLive(payout, "submitting");
    } catch {
      payout.state = "reconciliation_required";
      this.store.saveLive(payout, "submitting");
      throw new OfframpError(
        "SUBMISSION_UNCERTAIN",
        `Payout ${id} may already have been funded. Do not create a replacement or resend. Inspect this payout and reconcile its persisted PAJ and Circle references.`,
      );
    }
    return this.status(id);
  }

  async status(id: string): Promise<LivePayoutSummary> {
    const payout = this.load(id);
    if (
      ["prepared", "authorising", "submitting", "provider_completed", "failed"].includes(
        payout.state,
      )
    )
      return this.summary(payout);
    const provider = await this.provider().transaction(payout.order.id);
    const sameAddress = (value: string | undefined, expected: string) =>
      typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
    // PAJ's settled transaction replaces the quote's address with the sender
    // and createdAt with the deposit time. Bind that receipt to the confirmed
    // Circle hash, source and original destination; never rewrite the quote.
    const receiptMatches =
      typeof provider.signature === "string" &&
      /^0x[0-9a-f]{64}$/i.test(provider.signature) &&
      typeof payout.transactionHash === "string" &&
      provider.signature.toLowerCase() === payout.transactionHash.toLowerCase() &&
      sameAddress(provider.sender, payout.sourceAddress) &&
      sameAddress(provider.recipient, payout.order.depositAddress) &&
      (sameAddress(provider.depositAddress, payout.sourceAddress) ||
        sameAddress(provider.depositAddress, payout.order.depositAddress));
    const orderUnchanged =
      sameAddress(provider.depositAddress, payout.order.depositAddress) &&
      provider.createdAt === payout.order.createdAt;
    requireThat(
      provider.chain === payout.order.chain &&
        provider.mint.toLowerCase() === payout.order.mint.toLowerCase() &&
        provider.usdc === payout.order.usdc &&
        (provider.signature ? receiptMatches : orderUnchanged),
      "PROVIDER_ORDER_CHANGED",
      "PAJ returned different settlement details. Reconcile this existing payout.",
    );
    const current = this.load(id);
    if (current.state === "provider_completed" || current.state === "failed")
      return this.summary(current);
    const previous = current.state;
    current.providerStatus = provider.status;
    if (receiptMatches) current.providerReceipt = provider;
    if (provider.status === "COMPLETED") {
      current.state = "provider_completed";
      current.finalProviderNgn = provider.ngn;
    }
    if (provider.status === "ERROR") current.state = "failed";
    this.store.saveLive(current, previous);
    return this.summary(this.load(id));
  }

  history() {
    return this.store.recentLive().map((payout) => this.summary(payout));
  }

  private summary(payout: LivePayout): LivePayoutSummary {
    return {
      payoutId: payout.id,
      mode: "live",
      simulated: false,
      state: payout.state,
      recipient: {
        name: payout.bank.accountName,
        bank: payout.bank.bankName,
        accountEnding: payout.bank.accountNumber.slice(-4),
      },
      estimatedReceiveNgn: payout.order.ngn,
      ngnAmountGuaranteed: false,
      providerChargeUsdc: payout.order.usdc,
      estimatedNetworkFeeUsdc: decimal(BigInt(payout.estimatedFeeUnits)),
      estimatedTotalDebitUsdc: decimal(units(payout.order.usdc) + BigInt(payout.estimatedFeeUnits)),
      budgetUsdc: decimal(BigInt(payout.budgetUnits)),
      budgetBasis: payout.requested.currency === "USDC" ? "requested" : "configured_limit",
      networkFeeReserveUsdc: decimal(BigInt(payout.feeReserveUnits)),
      networkFeeCapped: false,
      source: "USDC on Arc",
      approvalExpiresAt: payout.approvalExpiresAt,
      providerOrderId: payout.order.id,
      ...(payout.circleTransactionId ? { circleTransactionId: payout.circleTransactionId } : {}),
      ...(payout.providerStatus ? { providerStatus: payout.providerStatus } : {}),
      ...(payout.finalProviderNgn ? { finalProviderNgn: payout.finalProviderNgn } : {}),
      providerTransferMatched: Boolean(payout.providerReceipt),
      bankCreditIndependentlyVerified: false,
    };
  }
}
