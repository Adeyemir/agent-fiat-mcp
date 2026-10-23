import { OfframpError, requireThat } from "../errors.js";
import { jsonRequest, record } from "../http.js";
import { decimal, sameName, units } from "../money.js";
import type { BankAccount, BankInput } from "../types.js";

export type PajEnvironment = "staging" | "production";
export type PajChain = "ARC" | "BASE";
export type JsonRequest = (url: string, options?: RequestInit) => Promise<unknown>;
export const PAJ_USDC = { ARC: "0x3600000000000000000000000000000000000000", BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } as const;
export const PAJ_DOCUMENTED_CHAINS = ["SOLANA", "TON", "ETHEREUM", "BASE", "BSC", "MONAD", "ARC"] as const;
export interface PajBank { id: string; name: string; code: string; country: "NG" }
export interface PajChainInfo { chain: string; name: string; isActive: boolean }
export type PajStatus = "INIT" | "PROCESSING" | "COMPLETED" | "ERROR";
export interface PajOrder {
  id: string; depositAddress: string; mint: string; currency: "NGN";
  usdc: string; ngn: string; chain: PajChain; status: PajStatus;
  transactionType: "OFF_RAMP" | "ON_RAMP"; providerFeeUsdc: string; createdAt: string;
  signature?: string; sender?: string; recipient?: string; accountNumber?: string; accountName?: string; bank?: string;
}

function text(value: unknown, field: string, maximum = 256): string {
  requireThat(typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\r\n]/.test(value), "INVALID_PROVIDER_RESPONSE", `PAJ returned an invalid ${field}.`);
  return value;
}

export function providerAmount(value: unknown, decimals = 6, allowZero = false): string {
  requireThat(typeof value === "string" || (typeof value === "number" && Number.isFinite(value)), "INVALID_PROVIDER_RESPONSE", "PAJ returned an invalid amount.");
  const valueText = String(value);
  if (allowZero && /^0(?:\.0+)?$/.test(valueText) && valueText.length <= 30) return "0";
  try {
    const parsed = units(valueText, decimals);
    requireThat(typeof value !== "number" || parsed <= BigInt(Number.MAX_SAFE_INTEGER), "INVALID_PROVIDER_RESPONSE", "PAJ returned an amount outside the safe numeric range.");
    return decimal(parsed, decimals);
  } catch { throw new OfframpError("INVALID_PROVIDER_RESPONSE", "PAJ returned an amount that cannot be represented exactly at the required precision."); }
}

function reference(value: string): string {
  requireThat(/^[a-zA-Z0-9_-]{1,128}$/.test(value), "INVALID_PROVIDER_REFERENCE", "Use the provider reference returned by PAJ.");
  return value;
}

function jsonAmount(value: string, decimals = 6): number {
  const parsed = units(value, decimals);
  requireThat(parsed <= BigInt(Number.MAX_SAFE_INTEGER), "INVALID_AMOUNT", "The amount exceeds the provider's safe JSON numeric range.");
  const numeric = Number(value);
  requireThat(units(String(numeric), decimals) === parsed, "INVALID_AMOUNT", "The amount cannot be sent exactly to PAJ.");
  return numeric;
}

function order(value: unknown, kind: "OFF_RAMP" | "ON_RAMP"): PajOrder {
  const data = record(value);
  requireThat(data.currency === "NGN" && data.transactionType === kind, "INVALID_PROVIDER_ORDER", "PAJ returned a different currency or transaction type.");
  requireThat(data.chain === "ARC" || (kind === "ON_RAMP" && data.chain === "BASE"), "UNSUPPORTED_SETTLEMENT_CHAIN", "PAJ returned a different settlement chain.");
  requireThat(typeof data.mint === "string" && data.mint.toLowerCase() === PAJ_USDC[data.chain].toLowerCase(), "INVALID_PROVIDER_TOKEN", "PAJ returned a different USDC contract.");
  requireThat(["INIT", "PROCESSING", "COMPLETED", "ERROR"].includes(String(data.status)), "INVALID_PROVIDER_ORDER", "PAJ returned an undocumented order status.");
  const createdAt = text(data.createdAt, "order creation time");
  requireThat(Number.isFinite(Date.parse(createdAt)), "INVALID_PROVIDER_ORDER", "PAJ returned an invalid order creation time.");
  const address = kind === "OFF_RAMP" ? text(data.address, "deposit address") : typeof data.address === "string" ? data.address : "";
  if (kind === "OFF_RAMP") requireThat(/^0x[0-9a-f]{40}$/i.test(address) && !/^0x0{40}$/i.test(address), "INVALID_PROVIDER_ORDER", "PAJ returned an invalid Arc funding address.");
  return {
    id: reference(text(data.id, "order ID")), depositAddress: address, mint: data.mint,
    currency: "NGN", usdc: providerAmount(data.amount), ngn: providerAmount(data.fiatAmount, 2),
    chain: data.chain, status: data.status as PajStatus, transactionType: kind,
    providerFeeUsdc: data.fee === undefined ? "0" : providerAmount(data.fee, 6, true), createdAt,
    ...(typeof data.signature === "string" && data.signature.length > 0 ? { signature: text(data.signature, "transaction signature", 128) } : {}),
    ...(typeof data.sender === "string" && data.sender.length > 0 ? { sender: text(data.sender, "transaction sender") } : {}),
    ...(typeof data.recipient === "string" ? { recipient: data.recipient } : {}),
    ...(typeof data.accountNumber === "string" ? { accountNumber: data.accountNumber } : {}),
    ...(typeof data.accountName === "string" ? { accountName: data.accountName } : {}),
    ...(typeof data.bank === "string" ? { bank: data.bank } : {}),
  };
}

// https://docs.paj.cash/: every v2 operation uses x-api-key. Legacy email/OTP
// sessions are deliberately not read or accepted by this client.
export class PajClient {
  readonly baseUrl = "https://api.paj.cash/pub/v2";
  #apiKey: string | undefined;
  constructor(readonly environment: PajEnvironment = "production", apiKey?: string, private readonly request: JsonRequest = jsonRequest) {
    if (apiKey) {
      requireThat(apiKey.length <= 16_384 && !/\s/.test(apiKey), "INVALID_CONFIG", "The PAJ Business API key is malformed.");
      this.#apiKey = apiKey;
    }
  }

  private async call(path: string, body?: unknown): Promise<unknown> {
    requireThat(this.environment === "production", "PROVIDER_ENVIRONMENT_UNVERIFIED", "PAJ's v2 documentation specifies production only. A staging v2 contract has not been verified.");
    requireThat(this.#apiKey, "PROVIDER_API_KEY_REQUIRED", "Configure your PAJ Business API key locally. V2 does not require email login or an OTP session.");
    try {
      return await this.request(`${this.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "x-api-key": this.#apiKey },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof OfframpError) throw error;
      throw new OfframpError("PROVIDER_REQUEST_FAILED", "The PAJ request did not complete. No automatic order retry was made.");
    }
  }

  async rate(direction: "offRamp" | "onRamp" = "offRamp") {
    const response = record(record(await this.call("/rate?currency=NGN"))[`${direction}Rate`]);
    requireThat(response.baseCurrency === "USD" && response.targetCurrency === "NGN" && response.type === direction, "INVALID_RATE", "PAJ did not return the requested USD-to-NGN rate.");
    return { ngnPerUsdc: providerAmount(response.rate), indicativeOnly: true as const, feesIncluded: true as const, direction, observedAt: new Date().toISOString(), ...(typeof response.createdAt === "string" ? { providerUpdatedAt: response.createdAt } : {}) };
  }

  async chains(): Promise<PajChainInfo[]> {
    const response = await this.call("/chains");
    requireThat(Array.isArray(response), "INVALID_PROVIDER_RESPONSE", "PAJ did not return its chain list.");
    return response.map(value => { const data = record(value); requireThat(typeof data.isActive === "boolean", "INVALID_PROVIDER_RESPONSE", "PAJ returned an invalid chain availability flag."); return { chain: text(data.chain, "chain"), name: text(data.name, "chain name"), isActive: data.isActive }; });
  }

  async requireActive(chain: PajChain) {
    requireThat((await this.chains()).some(item => item.chain === chain && item.isActive), "PROVIDER_CHAIN_INACTIVE", `PAJ is not currently accepting orders on ${chain}.`);
  }

  async banks(): Promise<PajBank[]> {
    const response = await this.call("/bank?country=NG");
    requireThat(Array.isArray(response), "INVALID_PROVIDER_RESPONSE", "PAJ did not return a bank directory.");
    return response.map(record).filter(bank => bank.country === "NG" && typeof bank.name === "string" && bank.name.trim().length > 0).map(bank => ({ id: text(bank.id, "bank ID"), name: text(bank.name, "bank name"), code: text(bank.code, "bank code"), country: "NG" as const }));
  }

  async verifyBank(input: BankInput): Promise<BankAccount> {
    requireThat(/^\d{10}$/.test(input.accountNumber) && input.expectedName.trim().length > 0, "INVALID_BANK_ACCOUNT", "Provide a ten-digit Nigerian account number and expected full account holder name.");
    const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const matches = (await this.banks()).filter(bank => bank.id === input.bank || bank.code === input.bank || normalise(bank.name) === normalise(input.bank));
    requireThat(matches.length === 1, "BANK_SELECTION_REQUIRED", "Use the exact Nigerian bank name or code. Ambiguous names are not selected automatically.");
    const bank = matches[0]!;
    const data = record(await this.call("/bank-account", { bankCode: bank.code, accountNumber: input.accountNumber }));
    requireThat(data.accountNumber === input.accountNumber && typeof data.bank === "string" && [bank.name, bank.id, bank.code].some(value => normalise(value) === normalise(data.bank as string)), "BANK_DETAILS_CHANGED", "PAJ resolved different bank account details. Do not proceed.");
    const name = text(data.accountName, "account holder name");
    requireThat(sameName(name, input.expectedName), "NAME_MISMATCH", "The resolved holder name does not match the expected full name.");
    // Registration returns a Solana-only standing address. Arc payouts must
    // always use the fresh funding address supplied by an Arc order instead.
    return { bankId: bank.id, bankCode: bank.code, bankName: bank.name, accountNumber: input.accountNumber, accountName: name };
  }

  async createOfframp(input: { bankCode: string; accountNumber: string; receiveNgn?: string; usdc?: string }): Promise<PajOrder> {
    requireThat(/^[a-zA-Z0-9_-]{1,32}$/.test(input.bankCode) && /^\d{10}$/.test(input.accountNumber), "INVALID_BANK_ACCOUNT", "Use the verified bank code and ten-digit account number.");
    requireThat((input.receiveNgn === undefined) !== (input.usdc === undefined), "INVALID_AMOUNT", "Specify either an NGN target or a USDC amount, not both.");
    const amountBody = input.usdc !== undefined ? { amount: jsonAmount(input.usdc) } : { fiatAmount: jsonAmount(input.receiveNgn!, 2) };
    await this.requireActive("ARC");
    const result = order(await this.call("/offramp", { bankCode: input.bankCode, accountNumber: input.accountNumber, currency: "NGN", chain: "ARC", mint: PAJ_USDC.ARC, ...amountBody }), "OFF_RAMP");
    requireThat(result.status === "INIT" && (input.usdc === undefined || result.usdc === decimal(units(input.usdc))) && (input.receiveNgn === undefined || result.ngn === decimal(units(input.receiveNgn, 2), 2)), "INVALID_PROVIDER_ORDER", "PAJ changed the requested quote or returned an order that is not awaiting funds.");
    return result;
  }

  async createOnramp(input: { receiveAddress: string; chain: PajChain; spendNgn: string }): Promise<PajOrder> {
    requireThat((input.chain === "ARC" || input.chain === "BASE") && /^0x[0-9a-f]{40}$/i.test(input.receiveAddress) && !/^0x0{40}$/i.test(input.receiveAddress), "INVALID_RECIPIENT", "Use the saved Circle Agent Wallet on the selected network.");
    const fiatAmount = jsonAmount(input.spendNgn, 2);
    await this.requireActive(input.chain);
    const result = order(await this.call("/onramp", { fiatAmount, currency: "NGN", chain: input.chain, mint: PAJ_USDC[input.chain], recipient: input.receiveAddress }), "ON_RAMP");
    requireThat(result.chain === input.chain && result.recipient?.toLowerCase() === input.receiveAddress.toLowerCase() && result.ngn === decimal(units(input.spendNgn, 2), 2) && result.status === "INIT" && typeof result.accountNumber === "string" && /^\d{10}$/.test(result.accountNumber) && result.bank && result.accountName, "INVALID_PROVIDER_ORDER", "PAJ returned different funding details. Do not transfer fiat.");
    return result;
  }

  async transaction(id: string, kind: "OFF_RAMP" | "ON_RAMP" = "OFF_RAMP"): Promise<PajOrder> {
    const result = order(await this.call(`/transaction/${reference(id)}`), kind);
    requireThat(result.id === id, "INVALID_PROVIDER_ORDER", "PAJ returned a different order.");
    return result;
  }

  async checkOrder(expected: PajOrder) {
    const current = await this.transaction(expected.id, expected.transactionType);
    requireThat(current.status === "INIT" && current.depositAddress.toLowerCase() === expected.depositAddress.toLowerCase() && current.mint.toLowerCase() === expected.mint.toLowerCase() && current.usdc === expected.usdc && current.ngn === expected.ngn && current.chain === expected.chain && current.createdAt === expected.createdAt, "PROVIDER_ORDER_CHANGED", "The order changed or is no longer awaiting funds. Do not send another payment.");
    return current;
  }
}
