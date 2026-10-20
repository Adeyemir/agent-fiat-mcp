import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { OfframpError, publicError } from "../src/errors.js";
import { LiveService } from "../src/live-service.js";
import { createMcpServer, payoutApprovalMessage } from "../src/mcp.js";
import { Store } from "../src/store.js";
import { bank, destination, fixture, source } from "./fixtures/live.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof OfframpError && error.code === expected;

test("live preparation binds the saved bank and Arc order and discloses NGN/fee estimates", async (t) => {
  const { service, transfers } = fixture(t);
  const quote = await service.prepare({ amount: "10", currency: "USDC" });
  assert.equal(quote.providerChargeUsdc, "9.95");
  assert.equal(quote.estimatedNetworkFeeUsdc, "0.02");
  assert.equal(quote.estimatedTotalDebitUsdc, "9.97");
  assert.equal(quote.budgetUsdc, "10");
  assert.equal(quote.budgetBasis, "requested");
  assert.equal(quote.networkFeeReserveUsdc, "0.05");
  assert.equal(quote.ngnAmountGuaranteed, false);
  assert.equal(quote.networkFeeCapped, false);
  assert.equal(quote.bankCreditIndependentlyVerified, false);
  assert.equal(transfers.length, 0);
  for (const secret of [source, destination, bank.accountNumber])
    assert.equal(JSON.stringify(quote).includes(secret), false);
  const message = payoutApprovalMessage(quote, bank);
  assert.ok(message.includes(bank.accountNumber));
  assert.ok(message.includes("not guaranteed"));
  assert.ok(message.includes("does not expose a hard network-fee cap"));
});

test("only human approval permits one transfer; chain success remains bank_pending", async (t) => {
  const { service, transfers, store } = fixture(t);
  const quote = await service.prepare({ amount: "15000", currency: "NGN" });
  await assert.rejects(
    service.execute(quote.payoutId, async () => false),
    code("APPROVAL_REQUIRED"),
  );
  assert.equal(transfers.length, 0);
  const result = await service.execute(quote.payoutId, async (approved) => {
    assert.equal(approved.payoutId, quote.payoutId);
    return true;
  });
  assert.equal(result.state, "bank_pending");
  assert.equal(result.bankCreditIndependentlyVerified, false);
  assert.equal(store.live(quote.payoutId).circleTransactionId, "circle_transaction_1");
  assert.deepEqual(transfers, [{ to: destination, usdc: "10.1", idempotencyKey: quote.payoutId }]); // Fee is not added twice.
  await service.execute(quote.payoutId, async () => {
    assert.fail("Already submitted");
  });
  assert.equal(transfers.length, 1);
});

test("provider completion retains the final repriced NGN without inventing independent bank credit", async (t) => {
  const { service, control } = fixture(t);
  const quote = await service.prepare({ amount: "10", currency: "USDC" });
  await service.execute(quote.payoutId, async () => true);
  control.status = "COMPLETED";
  control.finalNgn = 14900;
  const result = await service.status(quote.payoutId);
  assert.equal(result.state, "provider_completed");
  assert.equal(result.estimatedReceiveNgn, "14925");
  assert.equal(result.finalProviderNgn, "14900");
  assert.equal(result.bankCreditIndependentlyVerified, false);
});

test("PAJ's settled receipt may replace address and timestamp only when its transfer matches Circle", async (t) => {
  const f = fixture(t);
  const quote = await f.service.prepare({ amount: "10", currency: "USDC" });
  await f.service.execute(quote.payoutId, async () => true);
  f.control.status = "COMPLETED";
  f.control.finalNgn = 14900;
  f.control.receipt = {
    address: source,
    sender: source,
    recipient: destination,
    signature: `0x${"a".repeat(64)}`,
    createdAt: new Date(f.control.now + 30_000).toISOString(),
  };
  const result = await f.service.status(quote.payoutId);
  assert.equal(result.state, "provider_completed");
  assert.equal(result.providerTransferMatched, true);
  assert.equal(result.finalProviderNgn, "14900");
  assert.equal(result.bankCreditIndependentlyVerified, false);
  const saved = f.store.live(quote.payoutId);
  assert.equal(saved.order.depositAddress, destination);
  assert.equal(saved.order.createdAt, new Date(f.control.now).toISOString());
  assert.equal(saved.providerReceipt?.signature, saved.transactionHash);
  for (const secret of [source, destination, bank.accountNumber])
    assert.equal(JSON.stringify(result).includes(secret), false);
  await f.service.execute(quote.payoutId, async () => {
    assert.fail("Do not re-approve a completed payout");
  });
  assert.equal(f.transfers.length, 1);
});

test("changed settled receipts cannot bypass hash, source, destination, token or amount checks", async (t) => {
  const unknown = "0x3333333333333333333333333333333333333333";
  for (const tamper of [
    { signature: `0x${"b".repeat(64)}` },
    { signature: "" },
    { sender: unknown },
    { recipient: unknown },
    { address: unknown },
    { mint: unknown },
    { amount: 10 },
  ]) {
    const f = fixture(t);
    const quote = await f.service.prepare({ amount: "10", currency: "USDC" });
    await f.service.execute(quote.payoutId, async () => true);
    f.control.status = "COMPLETED";
    f.control.receipt = {
      address: source,
      sender: source,
      recipient: destination,
      signature: `0x${"a".repeat(64)}`,
      createdAt: new Date(f.control.now + 30_000).toISOString(),
      ...tamper,
    };
    await assert.rejects(
      f.service.status(quote.payoutId),
      code("mint" in tamper ? "INVALID_PROVIDER_TOKEN" : "PROVIDER_ORDER_CHANGED"),
    );
    assert.equal(f.store.live(quote.payoutId).state, "bank_pending");
    assert.equal(f.store.live(quote.payoutId).providerReceipt, undefined);
    assert.equal(f.transfers.length, 1);
  }
});

test("even an unchanged order cannot claim completion with a different transfer signature", async (t) => {
  const f = fixture(t);
  const quote = await f.service.prepare({ amount: "10", currency: "USDC" });
  await f.service.execute(quote.payoutId, async () => true);
  f.control.status = "COMPLETED";
  f.control.receipt = { signature: `0x${"b".repeat(64)}`, sender: source, recipient: destination };
  await assert.rejects(f.service.status(quote.payoutId), code("PROVIDER_ORDER_CHANGED"));
  assert.equal(f.transfers.length, 1);
});

test("an ambiguous transfer is persisted and never resent, including after a restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-live-uncertain-"));
  const path = join(dir, "live.sqlite");
  const f = fixture(t, path);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const quote = await f.service.prepare({ amount: "10", currency: "USDC" });
  f.control.failTransfer = true;
  try {
    await f.service.execute(quote.payoutId, async () => true);
    assert.fail("Expected uncertainty");
  } catch (error) {
    assert.equal(publicError(error).code, "SUBMISSION_UNCERTAIN");
    assert.equal(
      JSON.stringify(publicError(error)).includes("fake-private-circle-response"),
      false,
    );
  }
  assert.equal(f.store.live(quote.payoutId).state, "reconciliation_required");
  const second = new Store(path);
  try {
    const restarted = new LiveService(f.config, second, f.request, f.wallet, () => f.control.now);
    assert.equal(
      (
        await restarted.execute(quote.payoutId, async () => {
          assert.fail("Must not re-approve");
        })
      ).state,
      "reconciliation_required",
    );
    assert.equal(f.transfers.length, 1);
    f.control.status = "COMPLETED";
    assert.equal((await restarted.status(quote.payoutId)).state, "provider_completed");
  } finally {
    second.close();
  }
});

test("two SQLite connections cannot submit the same live quote twice", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-live-concurrent-"));
  const path = join(dir, "live.sqlite");
  const f = fixture(t, path);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const other = new Store(path);
  try {
    const quote = await f.service.prepare({ amount: "10", currency: "USDC" });
    const second = new LiveService(f.config, other, f.request, f.wallet, () => f.control.now);
    await Promise.all([
      f.service.execute(quote.payoutId, async () => true),
      second.execute(quote.payoutId, async () => true),
    ]);
    assert.equal(f.transfers.length, 1);
  } finally {
    other.close();
  }
});

test("expiry during approval, a changed deposit address, or a fee increase prevents transfer", async (t) => {
  for (const variant of ["expiry", "address", "fee"] as const) {
    const f = fixture(t);
    const quote = await f.service.prepare({ amount: "10", currency: "USDC" });
    if (variant === "address") f.control.alterDestination = true;
    await assert.rejects(
      f.service.execute(quote.payoutId, async () => {
        if (variant === "expiry") f.control.now += 6 * 60_000;
        if (variant === "fee") f.control.fee = "0.06";
        return true;
      }),
      code(
        variant === "expiry"
          ? "QUOTE_EXPIRED"
          : variant === "address"
            ? "PROVIDER_ORDER_CHANGED"
            : "NETWORK_FEE_CHANGED",
      ),
    );
    assert.equal(f.transfers.length, 0);
  }
});

test("stale pooled addresses, insufficient balance and testnet cannot create executable payouts", async (t) => {
  const stale = fixture(t);
  stale.control.orderAgeMs = 2 * 60 * 60_000;
  await assert.rejects(
    stale.service.prepare({ amount: "10", currency: "USDC" }),
    code("QUOTE_EXPIRED"),
  );
  assert.equal(stale.store.recentLive().length, 0);
  const poor = fixture(t);
  poor.control.balance = "0.01";
  await assert.rejects(
    poor.service.prepare({ amount: "10", currency: "USDC" }),
    code("INSUFFICIENT_BALANCE"),
  );
  const wrong = fixture(t);
  const testnet = new LiveService(
    { ...wrong.config, arcNetwork: "testnet" },
    wrong.store,
    wrong.request,
    wrong.wallet,
  );
  await assert.rejects(
    testnet.prepare({ amount: "10", currency: "USDC" }),
    code("LIVE_NETWORK_UNVERIFIED"),
  );
  assert.equal(wrong.orders.size, 0);
});

test("ERROR reports a failed provider payout without resending or claiming a refund", async (t) => {
  const f = fixture(t);
  const quote = await f.service.prepare({ amount: "10", currency: "USDC" });
  await f.service.execute(quote.payoutId, async () => true);
  f.control.status = "ERROR";
  assert.equal((await f.service.status(quote.payoutId)).state, "failed");
  assert.equal((await f.service.execute(quote.payoutId, async () => true)).state, "failed");
  assert.equal(f.transfers.length, 1);
});

test("a prepared payout cannot be executed from a different saved source wallet", async (t) => {
  const f = fixture(t);
  const quote = await f.service.prepare({ amount: "10", currency: "USDC" });
  const changed = new LiveService({ ...f.config, arcAddress: destination }, f.store, f.request, {
    ...f.wallet,
    address: destination,
  });
  await assert.rejects(
    changed.execute(quote.payoutId, async () => true),
    code("PAYMENT_SOURCE_CHANGED"),
  );
  assert.equal(f.transfers.length, 0);
});

test("a one-off recipient overrides the default without changing it", async (t) => {
  const f = fixture(t);
  f.store.setBank("live:production:mainnet", {
    ...bank,
    accountNumber: "1111111111",
    accountName: "OTHER RECIPIENT",
  });
  const quote = await f.service.prepare({
    amount: "10",
    currency: "USDC",
    bank: {
      bank: bank.bankCode,
      accountNumber: bank.accountNumber,
      expectedName: bank.accountName,
    },
  });
  assert.equal(quote.recipient.accountEnding, "6789");
  assert.equal(f.service.defaultBank()?.accountEnding, "1111");
  assert.equal(f.transfers.length, 0);
});

test("a one-off payout does not require a saved recipient", async (t) => {
  const f = fixture(t);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const service = new LiveService(f.config, store, f.request, f.wallet, () => f.control.now);
  assert.equal(service.defaultBank(), null);
  const quote = await service.prepare({
    amount: "10",
    currency: "USDC",
    bank: {
      bank: bank.bankCode,
      accountNumber: bank.accountNumber,
      expectedName: bank.accountName,
    },
  });
  assert.equal(quote.recipient.accountEnding, "6789");
  assert.equal(service.defaultBank(), null);
});

test("invalid amounts and budgets cannot create provider orders", async (t) => {
  const f = fixture(t);
  for (const amount of ["0", "-1", "1e3", "NaN", "1.0000001", "01", "1."]) {
    await assert.rejects(f.service.prepare({ amount, currency: "USDC" }), code("INVALID_AMOUNT"));
  }
  await assert.rejects(
    f.service.prepare({ amount: "1000.001", currency: "NGN" }),
    code("INVALID_AMOUNT"),
  );
  await assert.rejects(
    f.service.prepare({ amount: "101", currency: "USDC" }),
    code("PAYOUT_LIMIT"),
  );
  await assert.rejects(
    f.service.prepare({ amount: "0.05", currency: "USDC" }),
    code("PAYOUT_LIMIT"),
  );
  assert.equal(f.orders.size, 0);
});

test("a reduced spending limit blocks an already prepared payout", async (t) => {
  const f = fixture(t);
  const quote = await f.service.prepare({ amount: "10", currency: "USDC" });
  const limited = new LiveService(
    { ...f.config, maximumUnits: 1_000_000n },
    f.store,
    f.request,
    f.wallet,
    () => f.control.now,
  );
  await assert.rejects(
    limited.execute(quote.payoutId, async () => {
      assert.fail("Must not request approval above the current limit");
    }),
    code("NETWORK_FEE_CHANGED"),
  );
  assert.equal(f.transfers.length, 0);
});

test("a slow provider response cannot overwrite a completed payout", async (t) => {
  const f = fixture(t);
  const quote = await f.service.prepare({ amount: "10", currency: "USDC" });
  await f.service.execute(quote.payoutId, async () => true);
  let release!: () => void;
  let entered!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const service = new LiveService(
    f.config,
    f.store,
    async (url, options) => {
      const response = await f.request(url, options);
      if (++calls === 1) {
        entered();
        await delayed;
      }
      return response;
    },
    f.wallet,
    () => f.control.now,
  );
  const older = service.status(quote.payoutId);
  await started;
  f.control.status = "COMPLETED";
  assert.equal((await service.status(quote.payoutId)).state, "provider_completed");
  release();
  assert.equal((await older).state, "provider_completed");
});

test("MCP obtains the real quote's human approval and refuses an injected approval argument", async (t) => {
  const f = fixture(t);
  const server = createMcpServer(f.service);
  const client = new Client(
    { name: "live-payout-test", version: "1" },
    { capabilities: { elicitation: { form: {} } } },
  );
  const prompts: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompts.push(request.params.message);
    return { action: "accept", content: { approve: true } };
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const prepared = await client.callTool({
      name: "prepare_payout",
      arguments: { amount: "10", currency: "USDC" },
    });
    const quote = (prepared.structuredContent as { result: { payoutId: string } }).result;
    assert.equal(
      (
        await client.callTool({
          name: "execute_payout",
          arguments: { payoutId: quote.payoutId, confirmed: true },
        })
      ).isError,
      true,
    );
    assert.equal(f.transfers.length, 0);
    const paid = await client.callTool({
      name: "execute_payout",
      arguments: { payoutId: quote.payoutId },
    });
    assert.equal(paid.isError, undefined);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]!.includes("Estimated receive"));
    assert.ok(prompts[0]!.includes("not guaranteed on-chain"));
    assert.equal(f.transfers.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
