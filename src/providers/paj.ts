import { randomUUID } from "node:crypto";
import { OfframpError, requireThat } from "../errors.js";
import { jsonRequest, record } from "../http.js";
import { decimal, sameName, units } from "../money.js";
import type { BankAccount, BankInput } from "../types.js";

export type PajEnvironment = "staging" | "production";
export type PajChain = "SOLANA" | "MONAD";
export type JsonRequest = (url: string, options?: RequestInit) => Promise<unknown>;
export const PAJ_URLS = { staging: "https://api-staging.paj.cash", production: "https://api.paj.cash" } as const;
// Circle's USDC address reference, checked 2026-10-19. Staging is a PAJ API
// environment, not proof that a particular chain is using testnet tokens.
export const PAJ_USDC = {
  SOLANA: { mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", testnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
  MONAD: { mainnet: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", testnet: "0x534b2f3A21130d7a60830c2Df862319e593943A3" },
} as const;

export interface PajBank { id: string; name: string; code: string; country: "NG" }
export interface PajSession { environment: PajEnvironment; token: string; expiresAt: string }
export interface PajOrder {
  id: string; depositAddress: string; mint: string; currency: "NGN";
  usdc: string; ngn: string; chain?: PajChain; status?: string;
  transactionType?: string; providerFeeUsdc?: string; expiresAt?: string;
}

function textField(value: unknown, field: string, maximum = 256): string {
  requireThat(typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\r\n]/.test(value), "INVALID_PROVIDER_RESPONSE", `PAJ returned an invalid ${field}.`);
  return value;
}

function amount(value: unknown, decimals = 6, allowZero = false): string {
  requireThat(typeof value === "string" || (typeof value === "number" && Number.isFinite(value)), "INVALID_PROVIDER_RESPONSE", "PAJ returned an invalid amount.");
  const text = String(value);
  if (allowZero && /^0(?:\.0{1,6})?$/.test(text)) return "0";
  try {
    const parsed = units(text, decimals);
    requireThat(typeof value !== "number" || parsed <= BigInt(Number.MAX_SAFE_INTEGER), "INVALID_PROVIDER_RESPONSE", "PAJ returned an amount outside the safe numeric range.");
    return decimal(parsed, decimals);
  } catch { throw new OfframpError("INVALID_PROVIDER_RESPONSE", "PAJ returned an amount that cannot be represented exactly at the required precision."); }
}

function reference(value: string): string {
  requireThat(/^[a-zA-Z0-9_-]{1,128}$/.test(value), "INVALID_PROVIDER_REFERENCE", "Use the provider reference returned by PAJ.");
  return value;
}

function order(value: unknown): PajOrder {
  const data = record(value);
  requireThat(data.currency === "NGN", "INVALID_PROVIDER_ORDER", "The PAJ order is not denominated in NGN.");
  if (data.chain !== undefined) requireThat(data.chain === "SOLANA" || data.chain === "MONAD", "UNSUPPORTED_SETTLEMENT_CHAIN", "PAJ returned an undocumented settlement chain.");
  const expiresAt = data.expiresAt;
  if (expiresAt !== undefined) requireThat(typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt)), "INVALID_PROVIDER_ORDER", "PAJ returned an invalid order expiry.");
  return {
    id: reference(textField(data.id, "order ID")), depositAddress: textField(data.address, "deposit address"),
    mint: textField(data.mint, "token"), currency: "NGN", usdc: amount(data.amount), ngn: amount(data.fiatAmount, 2),
    ...(data.chain ? { chain: data.chain as PajChain } : {}),
    ...(data.status !== undefined ? { status: textField(data.status, "status") } : {}),
    ...(data.transactionType !== undefined ? { transactionType: textField(data.transactionType, "transaction type") } : {}),
    ...(data.fee !== undefined ? { providerFeeUsdc: amount(data.fee, 6, true) } : {}),
    ...(typeof expiresAt === "string" ? { expiresAt } : {}),
  };
}

// Raw HTTP client for PAJ's published contract. It is deliberately separate from
// PayoutService: no Arc settlement or provider-credit behavior is inferred here.
export class PajClient {
  readonly baseUrl: string;
  #token: string | undefined;
  constructor(readonly environment: PajEnvironment = "staging", token?: string, private readonly request: JsonRequest = jsonRequest) {
    requireThat(environment === "staging" || environment === "production", "INVALID_CONFIG", "PAJ_ENVIRONMENT must be staging or production.");
    this.baseUrl = PAJ_URLS[environment];
    if (token) {
      requireThat(token.length <= 16_384 && !/\s/.test(token), "INVALID_CONFIG", "The PAJ session token is malformed. Authenticate again locally.");
      this.#token = token;
    }
  }

  private async call(path: string, options: { authenticated?: boolean; body?: unknown; apiKey?: string } = {}): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.authenticated) {
      requireThat(this.#token, "PROVIDER_LOGIN_REQUIRED", "Log in to PAJ locally with provider:login, or configure a PAJ session token for the selected environment.");
      headers.Authorization = `Bearer ${this.#token}`;
    }
    if (options.apiKey !== undefined) {
      requireThat(options.apiKey.trim().length > 0 && options.apiKey.length <= 16_384 && !/\s/.test(options.apiKey), "PROVIDER_API_KEY_REQUIRED", "Configure your PAJ Business API key locally.");
      headers["x-api-key"] = options.apiKey;
    }
    try {
      return await this.request(`${this.baseUrl}${path}`, {
        method: options.body === undefined ? "GET" : "POST", headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      if (error instanceof OfframpError) throw error;
      throw new OfframpError("PROVIDER_REQUEST_FAILED", "The PAJ request did not complete. Provider response bodies and credentials are withheld.");
    }
  }

  async initiateSession(email: string, apiKey: string): Promise<void> {
    requireThat(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254, "INVALID_EMAIL", "Provide your PAJ account email explicitly.");
    await this.call("/pub/initiate", { apiKey, body: { email } });
  }

  async verifySession(email: string, otp: string, apiKey: string): Promise<PajSession> {
    requireThat(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254, "INVALID_EMAIL", "Provide your PAJ account email explicitly.");
    requireThat(/^[a-zA-Z0-9-]{4,32}$/.test(otp), "INVALID_OTP", "Enter the one-time code PAJ sent to your email.");
    const response = record(await this.call("/pub/verify", { apiKey, body: { email, otp, device: { uuid: randomUUID(), device: "Desktop" } } }));
    const token = textField(response.token, "session token", 16_384);
    const expiresAt = textField(response.expiresAt, "session expiry");
    requireThat(Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.now() && !/\s/.test(token), "INVALID_PROVIDER_SESSION", "PAJ returned an expired or malformed session. Authenticate again locally.");
    requireThat(response.isActive === true || response.isActive === "true", "INACTIVE_PROVIDER_ACCOUNT", "The PAJ account is not active.");
    return { environment: this.environment, token, expiresAt };
  }

  async rate() {
    const response = record(await this.call("/pub/rate/offRamp"));
    requireThat(response.baseCurrency === "USD" && response.targetCurrency === "NGN" && response.type === "offRamp" && (response.isActive === undefined || response.isActive === true), "INVALID_RATE", "PAJ did not return a usable USD-to-NGN off-ramp rate.");
    return {
      ngnPerUsdc: amount(response.rate), indicativeOnly: true as const, active: response.isActive === true ? true : null, observedAt: new Date().toISOString(),
      ...(typeof response.createdAt === "string" ? { providerUpdatedAt: response.createdAt } : {}),
    };
  }

  async banks(): Promise<PajBank[]> {
    const response = await this.call("/pub/bank", { authenticated: true });
    requireThat(Array.isArray(response), "INVALID_PROVIDER_RESPONSE", "PAJ did not return a bank directory.");
    return response.map(record).filter(bank => bank.country === "NG").map(bank => ({
      id: reference(textField(bank.id, "bank ID")), name: textField(bank.name, "bank name"), code: textField(bank.code, "bank code"), country: "NG" as const,
    }));
  }

  async verifyBank(input: BankInput): Promise<BankAccount> {
    requireThat(/^\d{10}$/.test(input.accountNumber) && input.expectedName.trim().length > 0, "INVALID_BANK_ACCOUNT", "Provide a ten-digit Nigerian account number and expected full account holder name.");
    const directory = await this.banks();
    const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const matches = directory.filter(bank => bank.id === input.bank || bank.code === input.bank || normalise(bank.name) === normalise(input.bank));
    requireThat(matches.length === 1, "BANK_SELECTION_REQUIRED", "Use the exact Nigerian bank name or bank code from PAJ's bank directory. Ambiguous bank names are not selected automatically.");
    const bank = matches[0]!;
    const response = record(await this.call(`/pub/bank-account/confirm?${new URLSearchParams({ bankId: bank.id, accountNumber: input.accountNumber })}`, { authenticated: true }));
    const resolved = record(response.bank);
    const name = textField(response.accountName, "account holder name");
    requireThat(response.accountNumber === input.accountNumber && resolved.id === bank.id && resolved.country === "NG", "BANK_DETAILS_CHANGED", "PAJ resolved different bank account details. Do not proceed.");
    requireThat(sameName(name, input.expectedName), "NAME_MISMATCH", "The resolved account holder name does not match the expected full name.");
    return { bankId: bank.id, bankName: bank.name, accountNumber: input.accountNumber, accountName: name };
  }

  async saveBank(bank: BankAccount): Promise<string> {
    reference(bank.bankId);
    requireThat(/^\d{10}$/.test(bank.accountNumber), "INVALID_BANK_ACCOUNT", "Use a verified Nigerian bank account.");
    const response = record(await this.call("/pub/bank-account", { authenticated: true, body: { bankId: bank.bankId, accountNumber: bank.accountNumber } }));
    requireThat(response.accountNumber === bank.accountNumber && response.bank === bank.bankId && typeof response.accountName === "string" && sameName(response.accountName, bank.accountName), "BANK_DETAILS_CHANGED", "PAJ saved different bank details. Do not proceed.");
    return reference(textField(response.id, "saved account ID"));
  }

  async createOfframp(input: { bankReference: string; accountNumber: string; receiveNgn: bigint; chain: PajChain; mint: string }): Promise<PajOrder> {
    reference(input.bankReference);
    requireThat(/^\d{10}$/.test(input.accountNumber), "INVALID_BANK_ACCOUNT", "Use a verified Nigerian bank account.");
    requireThat(input.chain === "SOLANA" || input.chain === "MONAD", "UNSUPPORTED_SETTLEMENT_CHAIN", "PAJ's published API supports SOLANA and MONAD settlement, not direct ARC. A verified settlement route is required.");
    requireThat(typeof input.receiveNgn === "bigint" && input.receiveNgn > 0n && input.receiveNgn <= BigInt(Number.MAX_SAFE_INTEGER), "INVALID_AMOUNT", "Provide a whole-naira integer within PAJ's safe JSON numeric range.");
    const sameMint = (left: string, right: string) => input.chain === "MONAD" ? left.toLowerCase() === right.toLowerCase() : left === right;
    requireThat(Object.values(PAJ_USDC[input.chain]).some(mint => sameMint(mint, input.mint)), "INVALID_PROVIDER_TOKEN", "Use Circle-issued USDC on the explicitly chosen provider settlement network.");
    const response = order(await this.call("/pub/offramp", { authenticated: true, body: {
      bank: input.bankReference, accountNumber: input.accountNumber, currency: "NGN", fiatAmount: Number(input.receiveNgn),
      chain: input.chain, mint: input.mint, description: "Naira Offramp MCP payout",
    } }));
    requireThat(response.ngn === input.receiveNgn.toString() && sameMint(response.mint, input.mint) && (!response.chain || response.chain === input.chain), "INVALID_PROVIDER_ORDER", "PAJ changed the requested payout amount, token or settlement chain. Do not fund this order.");
    if (input.chain === "MONAD") requireThat(/^0x[0-9a-f]{40}$/i.test(response.depositAddress), "INVALID_PROVIDER_ORDER", "PAJ returned an invalid EVM deposit address.");
    else requireThat(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(response.depositAddress), "INVALID_PROVIDER_ORDER", "PAJ returned an invalid settlement deposit address.");
    // The API says to pay response.amount. Do not add response.fee a second time.
    // It does not document a quote TTL; never invent a provider-guaranteed expiry.
    return { ...response, chain: input.chain };
  }

  async transaction(id: string): Promise<PajOrder> {
    const response = order(await this.call(`/pub/transactions/${reference(id)}`, { authenticated: true }));
    requireThat(response.id === id && response.transactionType === "OFF_RAMP" && response.status, "INVALID_PROVIDER_ORDER", "PAJ returned a different order or an invalid off-ramp status.");
    return response;
  }

  async checkOrder(expected: PajOrder) {
    const current = await this.transaction(expected.id);
    requireThat(current.status === "INIT" && current.depositAddress === expected.depositAddress && current.mint === expected.mint && current.usdc === expected.usdc && current.ngn === expected.ngn && (!current.chain || current.chain === expected.chain), "PROVIDER_ORDER_CHANGED", "The PAJ order changed or is no longer awaiting payment. Do not submit another payment.");
    return current;
  }
}
