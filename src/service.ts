import { randomUUID } from "node:crypto";
import { OfframpError, requireThat } from "./errors.js";
import { decimal, units, wholeNaira } from "./money.js";
import { Store } from "./store.js";
import type { Approval, ArcSettlement, BankInput, Mode, OfframpProvider, Payout, PayoutSummary } from "./types.js";

export class PayoutService {
  constructor(
    readonly mode: Mode,
    private readonly provider: OfframpProvider,
    private readonly settlement: ArcSettlement,
    readonly store: Store,
    private readonly maximumUnits = 100_000_000n,
    private readonly now = () => Date.now(),
  ) {}

  async balance() {
    return { mode: this.mode, simulated: this.mode === "demo", source: "USDC on Arc", ...await this.settlement.balance() };
  }

  async verifyBank(input: BankInput) {
    requireThat(/^\d{10}$/.test(input.accountNumber), "INVALID_BANK_ACCOUNT", "Use a ten-digit Nigerian bank account number.");
    requireThat(input.bank.length > 0 && input.bank.length <= 120 && input.expectedName.trim().length > 0 && input.expectedName.length <= 160, "INVALID_BANK_ACCOUNT", "Provide the bank and expected account holder's full name.");
    return this.provider.verifyBank(input);
  }

  async setDefaultBank(input: BankInput, approve: (bank: { name: string; bank: string; accountNumber: string; simulated: boolean }) => Promise<boolean>) {
    const bank = await this.verifyBank(input);
    const approved = await approve({ name: bank.accountName, bank: bank.bankName, accountNumber: bank.accountNumber, simulated: this.mode === "demo" });
    requireThat(approved, "APPROVAL_REQUIRED", "The default bank account was not changed.");
    this.store.setBank(this.mode, bank);
    return { mode: this.mode, simulated: this.mode === "demo", name: bank.accountName, bank: bank.bankName, accountEnding: bank.accountNumber.slice(-4) };
  }

  defaultBank() {
    const bank = this.store.getBank(this.mode);
    return bank ? { name: bank.accountName, bank: bank.bankName, accountEnding: bank.accountNumber.slice(-4) } : null;
  }

  async prepare(input: { amount: string; currency: "NGN" | "USDC"; bank?: BankInput }): Promise<PayoutSummary> {
    requireThat(input.currency === "NGN" || input.currency === "USDC", "UNSUPPORTED_CURRENCY", "This version cashes out USDC on Arc to NGN only.");
    const budget = input.currency === "USDC" ? units(input.amount) : undefined;
    if (budget) requireThat(budget <= this.maximumUnits, "PAYOUT_LIMIT", "This request exceeds the configured per-payout USDC limit.");
    const bank = input.bank ? await this.verifyBank(input.bank) : this.store.getBank(this.mode);
    requireThat(bank, "DEFAULT_BANK_REQUIRED", "Set your verified default bank account once, or specify a bank account for this payout.");

    const rate = await this.provider.rate();
    requireThat(rate > 0n, "INVALID_RATE", "The provider did not return a usable exchange rate.");
    // USDC is a total spending budget, including the provider charge and maximum settlement fee.
    const reserve = 150_000n;
    let ngn = budget ? (budget > reserve ? (budget - reserve) * rate / 1_000_000_000_000n : 0n) : wholeNaira(input.amount);
    for (let attempt = 0; attempt < 3; attempt++) {
      requireThat(ngn >= this.provider.minimumNgn && ngn <= this.provider.maximumNgn, "PROVIDER_LIMIT", `The provider requires a payout between NGN ${this.provider.minimumNgn} and ${this.provider.maximumNgn}.`);
      const order = await this.provider.createOrder(bank, ngn);
      requireThat(order.ngn === ngn.toString() && /^\d+$/.test(order.usdcUnits) && BigInt(order.usdcUnits) > 0n, "INVALID_PROVIDER_ORDER", "The provider returned inconsistent quote details.");
      const plan = await this.settlement.prepare(order);
      requireThat(/^\d+$/.test(plan.feeUnits) && /^\d+$/.test(plan.totalUnits) && BigInt(plan.totalUnits) === BigInt(order.usdcUnits) + BigInt(plan.feeUnits), "INVALID_SETTLEMENT_QUOTE", "Settlement fees did not match the payout quote.");
      const total = BigInt(plan.totalUnits);
      if (budget && total > budget) {
        const excessNgn = ((total - budget) * rate + 999_999_999_999n) / 1_000_000_000_000n;
        ngn -= excessNgn + 1n;
        continue;
      }
      requireThat(total <= this.maximumUnits, "PAYOUT_LIMIT", "The quote including fees exceeds the configured per-payout USDC limit.");
      const expiry = Math.min(Date.parse(order.expiresAt), Date.parse(plan.expiresAt));
      requireThat(Number.isFinite(expiry) && expiry > this.now(), "QUOTE_EXPIRED", "The provider quote has expired or has an invalid expiry. Prepare a new payout.");
      const expiresAt = new Date(expiry).toISOString();
      await this.settlement.validate(plan);
      const payout: Payout = {
        id: randomUUID(), mode: this.mode, bank, order, plan, state: "prepared", createdAt: new Date(this.now()).toISOString(), expiresAt,
        requested: { amount: input.amount, currency: input.currency },
      };
      this.store.insert(payout);
      return this.summary(payout);
    }
    throw new OfframpError("BUDGET_TOO_SMALL", "A payout fitting your total USDC budget could not be quoted. Try a larger budget or an exact NGN amount.");
  }

  private load(id: string): Payout {
    const payout = this.store.get(id);
    requireThat(payout.mode === this.mode, "MODE_MISMATCH", "This payout belongs to a different mode/profile. Demo payouts can never be executed in live mode.");
    return payout;
  }

  async execute(id: string, approve: Approval): Promise<PayoutSummary> {
    const payout = this.load(id);
    // A repeated call resumes status inspection; it never repeats payment submission.
    if (payout.state !== "prepared") return this.status(id);
    requireThat(Date.parse(payout.expiresAt) > this.now(), "QUOTE_EXPIRED", "This quote has expired. Prepare a new payout; it was not paid.");
    requireThat(BigInt(payout.plan.totalUnits) <= this.maximumUnits, "PAYOUT_LIMIT", "This quote exceeds the current per-payout USDC limit.");
    requireThat(await approve(this.summary(payout), payout.bank), "APPROVAL_REQUIRED", "The payout was not approved; no funds were sent.");
    requireThat(Date.parse(payout.expiresAt) > this.now(), "QUOTE_EXPIRED", "The quote expired while awaiting approval. Prepare a new payout.");
    // Claim before any authorisation. SQLite makes this atomic across local MCP processes.
    if (!this.store.claim(payout, "prepared", "authorising")) return this.status(id);
    let authorisation: Record<string, unknown>;
    try {
      await this.provider.checkOrder(payout.order, payout.bank);
      await this.settlement.validate(payout.plan);
      authorisation = await this.settlement.authorise(payout.plan);
      requireThat(Date.parse(payout.expiresAt) > this.now(), "QUOTE_EXPIRED", "The quote expired before submission. Prepare a new payout.");
    } catch (error) {
      payout.state = "prepared";
      this.store.save(payout);
      throw error;
    }
    payout.state = "submitting";
    this.store.save(payout); // Persist before the request that could move funds.
    try {
      const result = await this.settlement.submit(authorisation);
      requireThat(result.id.length > 0, "INVALID_SETTLEMENT", "Settlement returned no transfer reference.");
      payout.settlementId = result.id;
      payout.state = "settling";
      this.store.save(payout);
    } catch {
      payout.state = "reconciliation_required";
      this.store.save(payout);
      throw new OfframpError("SUBMISSION_UNCERTAIN", `Payout ${id} needs reconciliation. A payment may have been submitted. Do not create a replacement payout or send again; inspect this payout's provider order and settlement records.`);
    }
    return this.status(id);
  }

  async status(id: string): Promise<PayoutSummary> {
    const payout = this.load(id);
    if (payout.state === "completed" || payout.state === "prepared" || payout.state === "authorising") return this.summary(payout);
    if (payout.state === "submitting") return this.summary(payout);
    let settlement;
    if (payout.settlementId && payout.state !== "reconciliation_required") {
      settlement = await this.settlement.status(payout.settlementId);
    }
    // Check the bank-provider result separately. A chain receipt never proves bank credit.
    const provider = await this.provider.status(payout.order);
    // Merge into the latest state synchronously after the network calls. Another
    // status request may already have recorded completion while these ran.
    const current = this.load(id);
    if (current.state === "completed") return this.summary(current);
    const expectedState = current.state;
    current.providerStatus = provider.status;
    if (settlement) {
      current.settlementStatus = settlement.status;
      if (settlement.delivered && current.state === "settling") current.state = "bank_pending";
    }
    if (provider.completed) current.state = "completed";
    this.store.saveIfState(current, expectedState);
    return this.summary(this.load(id));
  }

  history() { return this.store.recent(this.mode).map(p => this.summary(p)); }

  summary(payout: Payout): PayoutSummary {
    return {
      payoutId: payout.id, mode: payout.mode, simulated: payout.mode === "demo", state: payout.state,
      recipient: { name: payout.bank.accountName, bank: payout.bank.bankName, accountEnding: payout.bank.accountNumber.slice(-4) },
      receiveNgn: payout.order.ngn, providerChargeUsdc: decimal(BigInt(payout.order.usdcUnits)),
      settlementFeeMaximumUsdc: decimal(BigInt(payout.plan.feeUnits)), maximumDebitUsdc: decimal(BigInt(payout.plan.totalUnits)),
      source: "USDC on Arc", expiresAt: payout.expiresAt, bankPaid: payout.mode === "live" && payout.state === "completed",
    };
  }
}
