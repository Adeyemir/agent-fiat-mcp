import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoProvider, DemoSettlement } from "../src/adapters/demo.js";
import { loadConfig } from "../src/config.js";
import { OfframpError } from "../src/errors.js";
import { decimal, units } from "../src/money.js";
import { createRuntime } from "../src/runtime.js";
import { PayoutService } from "../src/service.js";
import { Store } from "../src/store.js";
import type { Mode } from "../src/types.js";

const bank = { bank: "Demo Bank", accountNumber: "0000000000", expectedName: "DEMO USER" };
const approve = async () => true;
const code = (expected: string) => (error: unknown) => error instanceof OfframpError && error.code === expected;

class ControlledProvider extends DemoProvider {
  completed = false;
  async status() { return { status: this.completed ? "COMPLETED" : "PROCESSING", completed: this.completed }; }
}
class ControlledSettlement extends DemoSettlement {
  submissions = 0;
  uncertain = false;
  delivered = true;
  async submit(authorisation: Record<string, unknown>) {
    this.submissions++;
    if (this.uncertain) throw new Error("Request timed out after it may have reached a provider");
    return super.submit(authorisation);
  }
  async status() { return { status: this.delivered ? "confirmed" : "pending", delivered: this.delivered }; }
}

function fixture(t: test.TestContext, mode: Mode = "demo") {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const provider = new ControlledProvider(store);
  const settlement = new ControlledSettlement(store);
  const service = new PayoutService(mode, provider, settlement, store);
  return { store, provider, settlement, service };
}

test("an exact NGN quote uses the saved bank, includes every fee and masks normal output", async t => {
  const { service } = fixture(t);
  await service.setDefaultBank(bank, approve);
  const quote = await service.prepare({ amount: "15000", currency: "NGN" });
  assert.equal(quote.receiveNgn, "15000");
  assert.equal(quote.providerChargeUsdc, "10.1");
  assert.equal(quote.settlementFeeMaximumUsdc, "0.05");
  assert.equal(quote.maximumDebitUsdc, "10.15");
  assert.equal(quote.state, "prepared");
  assert.equal(JSON.stringify(quote).includes(bank.accountNumber), false);
  assert.equal(JSON.stringify(service.history()).includes("depositAddress"), false);
});

test("USDC is a hard total budget including fees; a changed fee triggers a smaller quote", async t => {
  const { service, settlement } = fixture(t);
  const prepare = settlement.prepare.bind(settlement);
  settlement.prepare = async order => {
    const plan = await prepare(order);
    plan.feeUnits = "500000";
    plan.totalUnits = (BigInt(order.usdcUnits) + 500_000n).toString();
    return plan;
  };
  const quote = await service.prepare({ amount: "10", currency: "USDC", bank });
  assert.ok(units(quote.maximumDebitUsdc) <= 10_000_000n);
  assert.ok(BigInt(quote.receiveNgn) < 14775n);
});

test("unapproved or mismatched bank details are never saved", async t => {
  const { service } = fixture(t);
  await assert.rejects(service.setDefaultBank(bank, async () => false), code("APPROVAL_REQUIRED"));
  assert.equal(service.defaultBank(), null);
  await assert.rejects(service.setDefaultBank({ ...bank, expectedName: "SOMEONE ELSE" }, approve), code("NAME_MISMATCH"));
  await assert.rejects(service.setDefaultBank({ ...bank, accountNumber: "1234567890" }, approve), code("DEMO_ACCOUNT_ONLY"));
  await assert.rejects(service.prepare({ amount: "1000", currency: "NGN" }), code("DEFAULT_BANK_REQUIRED"));
});

test("rejected approval, expired quote, and a changed spending limit cannot debit the wallet", async t => {
  const { store, service, settlement, provider } = fixture(t);
  const quote = await service.prepare({ amount: "15000", currency: "NGN", bank });
  await assert.rejects(service.execute(quote.payoutId, async () => false), code("APPROVAL_REQUIRED"));
  const limited = new PayoutService("demo", provider, settlement, store, 1_000_000n);
  await assert.rejects(limited.execute(quote.payoutId, approve), code("PAYOUT_LIMIT"));
  const future = new PayoutService("demo", provider, settlement, store, 100_000_000n, () => Date.now() + 24 * 60 * 60_000);
  await assert.rejects(future.execute(quote.payoutId, approve), code("QUOTE_EXPIRED"));
  assert.equal(settlement.submissions, 0);
  assert.equal((await service.balance()).spendableUsdc, "100");
});

test("quote expiry while approval is pending is checked again", async t => {
  const { service, store, settlement, provider } = fixture(t);
  const quote = await service.prepare({ amount: "1000", currency: "NGN", bank });
  let now = Date.now();
  const clocked = new PayoutService("demo", provider, settlement, store, 100_000_000n, () => now);
  await assert.rejects(clocked.execute(quote.payoutId, async () => { now += 24 * 60 * 60_000; return true; }), code("QUOTE_EXPIRED"));
  assert.equal(settlement.submissions, 0);
});

test("a chain confirmation is bank_pending until the provider confirms payment", async t => {
  const { service, provider } = fixture(t, "live"); // Injected fake adapters, no network or real funds.
  const quote = await service.prepare({ amount: "15000", currency: "NGN", bank });
  const sent = await service.execute(quote.payoutId, approve);
  assert.equal(sent.state, "bank_pending");
  assert.equal(sent.bankPaid, false);
  provider.completed = true;
  const paid = await service.status(quote.payoutId);
  assert.equal(paid.state, "completed");
  assert.equal(paid.bankPaid, true);
});

test("ambiguous submission is persisted and repeated execute never pays again", async t => {
  const { service, settlement, store } = fixture(t);
  settlement.uncertain = true;
  const quote = await service.prepare({ amount: "1000", currency: "NGN", bank });
  await assert.rejects(service.execute(quote.payoutId, approve), code("SUBMISSION_UNCERTAIN"));
  assert.equal(store.get(quote.payoutId).state, "reconciliation_required");
  const retry = await service.execute(quote.payoutId, approve);
  assert.equal(retry.state, "reconciliation_required");
  assert.equal(settlement.submissions, 1);
});

test("two SQLite connections executing the same quote submit only once", async t => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-concurrency-"));
  const path = join(dir, "state.sqlite");
  const first = new Store(path);
  const second = new Store(path);
  t.after(() => { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); });
  const provider = new ControlledProvider(first);
  const settlement = new ControlledSettlement(first);
  const a = new PayoutService("demo", provider, settlement, first);
  const b = new PayoutService("demo", provider, settlement, second);
  const quote = await a.prepare({ amount: "15000", currency: "NGN", bank });
  await Promise.all([a.execute(quote.payoutId, approve), b.execute(quote.payoutId, approve)]);
  assert.equal(settlement.submissions, 1);
  assert.equal((await b.balance()).spendableUsdc, "89.85");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("the demo debit survives restart and completed execution is idempotent", async t => {
  const { service, store } = fixture(t);
  const quote = await service.prepare({ amount: "15000", currency: "NGN", bank });
  const executed = await service.execute(quote.payoutId, approve);
  assert.equal(executed.bankPaid, false);
  const restarted = new PayoutService("demo", new DemoProvider(store), new DemoSettlement(store), store);
  const repeated = await restarted.execute(quote.payoutId, async () => { throw new Error("No new approval for an existing payment"); });
  assert.equal(repeated.state, "completed");
  assert.equal(repeated.simulated, true);
  assert.equal(repeated.bankPaid, false);
  assert.equal((await restarted.balance()).spendableUsdc, "89.85");
});

test("mode separation prevents a demo quote being executed as live", async t => {
  const { store, provider, settlement, service } = fixture(t);
  const quote = await service.prepare({ amount: "1000", currency: "NGN", bank });
  const live = new PayoutService("live", provider, settlement, store);
  await assert.rejects(live.execute(quote.payoutId, approve), code("MODE_MISMATCH"));
});

test("malformed amounts, unsupported currencies, over-limit quotes and insufficient balances are refused", async t => {
  const { service } = fixture(t);
  for (const amount of ["0", "-1", "1e3", "NaN", "1.0000001", "01", "1."]) {
    await assert.rejects(service.prepare({ amount, currency: "USDC", bank }), code("INVALID_AMOUNT"));
  }
  await assert.rejects(service.prepare({ amount: "1000.01", currency: "NGN", bank }), code("INVALID_AMOUNT"));
  await assert.rejects(service.prepare({ amount: "101", currency: "USDC", bank }), code("PAYOUT_LIMIT"));
  await assert.rejects(service.prepare({ amount: "150000", currency: "NGN", bank }), code("PAYOUT_LIMIT"));
  const first = await service.prepare({ amount: "120000", currency: "NGN", bank });
  await service.execute(first.payoutId, approve);
  await assert.rejects(service.prepare({ amount: "45000", currency: "NGN", bank }), code("INSUFFICIENT_BALANCE"));
});

test("inconsistent provider totals and invalid quote expiry are rejected before saving", async t => {
  const { service, provider, settlement } = fixture(t);
  const original = settlement.prepare.bind(settlement);
  settlement.prepare = async order => ({ ...await original(order), totalUnits: "1" });
  await assert.rejects(service.prepare({ amount: "1000", currency: "NGN", bank }), code("INVALID_SETTLEMENT_QUOTE"));
  settlement.prepare = original;
  const order = provider.createOrder.bind(provider);
  provider.createOrder = async (recipient, amount) => ({ ...await order(recipient, amount), expiresAt: "invalid" });
  await assert.rejects(service.prepare({ amount: "1000", currency: "NGN", bank }), code("QUOTE_EXPIRED"));
  assert.equal(service.history().length, 0);
});

test("a slow status response cannot overwrite a completion already observed", async t => {
  const { service, provider } = fixture(t);
  const quote = await service.prepare({ amount: "1000", currency: "NGN", bank });
  await service.execute(quote.payoutId, approve);
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let call = 0;
  provider.status = async () => {
    if (++call === 1) { entered(); await delayed; return { status: "PROCESSING", completed: false }; }
    return { status: "COMPLETED", completed: true };
  };
  const older = service.status(quote.payoutId);
  await started;
  assert.equal((await service.status(quote.payoutId)).state, "completed");
  release();
  assert.equal((await older).state, "completed");
});

test("live mode cannot be switched on with a flag or credentials", () => {
  assert.throws(() => createRuntime(loadConfig({ OFFRAMP_MODE: "live", PAJ_GATEWAY_SETTLEMENT_VERIFIED: "true", PAJ_SESSION_TOKEN: "dummy" })), code("LIVE_ROUTE_UNAVAILABLE"));
  assert.throws(() => loadConfig({ OFFRAMP_MODE: "typo" }), code("INVALID_CONFIG"));
});

test("USDC round-trips exactly at six decimals without floating point arithmetic", () => {
  for (const value of ["0.000001", "10.123456", "100", "999999999999999999.123456"]) assert.equal(decimal(units(value)), value);
});
