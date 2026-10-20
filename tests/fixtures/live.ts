import type test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config.js";
import { LiveService, type LiveWallet } from "../../src/live-service.js";
import { PAJ_USDC, type JsonRequest } from "../../src/providers/paj.js";
import { Store } from "../../src/store.js";

export const source = "0x1111111111111111111111111111111111111111";
export const destination = "0x2222222222222222222222222222222222222222";
export const bank = {
  bankId: "bank_1",
  bankCode: "999",
  bankName: "Example Bank",
  accountNumber: "0123456789",
  accountName: "TEST USER",
};

export function fixture(t: test.TestContext, path = ":memory:") {
  const store = new Store(path);
  t.after(() => store.close());
  store.setBank("live:production:mainnet", bank);
  const config = loadConfig({ PAJ_API_KEY: "fake-key", CIRCLE_ARC_ADDRESS: source });
  const control = {
    now: Date.now(),
    status: "INIT",
    fee: "0.02",
    balance: "100",
    failTransfer: false,
    alterDestination: false,
    finalNgn: undefined as number | undefined,
    orderAgeMs: 0,
    receipt: undefined as Record<string, unknown> | undefined,
  };
  const orders = new Map<string, Record<string, unknown>>();
  const transfers: { to: string; usdc: string; idempotencyKey: string }[] = [];
  const request: JsonRequest = async (url, options = {}) => {
    assert.equal(new Headers(options.headers).get("x-api-key"), "fake-key");
    if (url.includes("/bank?"))
      return [{ id: bank.bankId, code: bank.bankCode, name: bank.bankName, country: "NG" }];
    if (url.endsWith("/bank-account"))
      return {
        id: "registered_1",
        accountNumber: bank.accountNumber,
        accountName: bank.accountName,
        bank: bank.bankName,
      };
    if (url.endsWith("/chains")) return [{ chain: "ARC", name: "Arc", isActive: true }];
    if (url.endsWith("/offramp")) {
      assert.equal(options.method, "POST");
      const body = JSON.parse(String(options.body));
      assert.equal(body.bankCode, bank.bankCode);
      assert.equal(body.accountNumber, bank.accountNumber);
      assert.equal(body.chain, "ARC");
      assert.equal(body.mint, PAJ_USDC.ARC);
      const id = `order_${orders.size + 1}`;
      const data = {
        id,
        address: destination,
        mint: PAJ_USDC.ARC,
        chain: "ARC",
        currency: "NGN",
        amount: body.amount ?? 10.1,
        fiatAmount: body.fiatAmount ?? Math.round(body.amount * 150000) / 100,
        fee: 0.1,
        status: "INIT",
        transactionType: "OFF_RAMP",
        createdAt: new Date(control.now - control.orderAgeMs).toISOString(),
      };
      orders.set(id, data);
      return data;
    }
    const raw = orders.get(url.split("/").at(-1)!);
    assert.ok(raw);
    return {
      ...raw,
      status: control.status,
      ...(control.alterDestination ? { address: source } : {}),
      ...(control.finalNgn === undefined ? {} : { fiatAmount: control.finalNgn }),
      ...control.receipt,
    };
  };
  const wallet: LiveWallet = {
    address: source,
    chain: "ARC",
    checkVersion: async () => "1.2.2",
    requireAgentWallet: async () => {},
    usdcBalance: async () => control.balance,
    estimateUsdcTransfer: async () => control.fee,
    transferUsdc: async (to, usdc, idempotencyKey) => {
      assert.equal(store.live(idempotencyKey).state, "submitting");
      assert.equal(store.live(idempotencyKey).order.depositAddress, to);
      transfers.push({ to, usdc, idempotencyKey });
      if (control.failTransfer) throw new Error("fake-private-circle-response");
      control.status = "PROCESSING";
      return { id: "circle_transaction_1", txHash: `0x${"a".repeat(64)}` };
    },
  };
  const service = new LiveService(config, store, request, wallet, () => control.now);
  return { service, store, config, wallet, request, control, transfers, orders };
}
