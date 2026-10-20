import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/mcp.js";
import { bank, fixture, source } from "./fixtures/live.js";

const input = {
  bank: bank.bankCode,
  accountNumber: bank.accountNumber,
  expectedName: bank.accountName,
};
const data = (response: Record<string, unknown>) =>
  response.structuredContent as { result?: Record<string, unknown>; error?: { code: string } };

async function setup(
  t: test.TestContext,
  forms = true,
  allow = true,
  readiness: () => Promise<unknown> = async () => ({ livePayoutsAvailable: true }),
) {
  const f = fixture(t);
  const server = createMcpServer(f.service, { readiness });
  const client = new Client(
    { name: "test-client", version: "1" },
    { capabilities: forms ? { elicitation: { form: {} } } : {} },
  );
  const prompts: string[] = [];
  if (forms)
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params.message);
      return allow ? { action: "accept", content: { approve: true } } : { action: "decline" };
    });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return { ...f, client, prompts };
}

test("MCP exposes nine tools and tracks a payout through provider completion", async (t) => {
  const f = await setup(t);
  assert.deepEqual((await f.client.listTools()).tools.map((tool) => tool.name).sort(), [
    "execute_payout",
    "get_balance",
    "get_default_bank",
    "get_readiness",
    "list_banks",
    "payout_history",
    "payout_status",
    "prepare_payout",
    "set_default_bank",
  ]);
  const quote = data(
    await f.client.callTool({
      name: "prepare_payout",
      arguments: { amount: "15000", currency: "NGN", bank: input },
    }),
  ).result!;
  assert.equal(quote.state, "prepared");
  assert.equal(f.transfers.length, 0);
  const sent = data(
    await f.client.callTool({ name: "execute_payout", arguments: { payoutId: quote.payoutId } }),
  ).result!;
  assert.equal(sent.state, "bank_pending");
  assert.equal(f.prompts.length, 1);
  assert.ok(f.prompts[0]!.includes(bank.accountNumber));
  assert.ok(f.prompts[0]!.includes("not guaranteed on-chain"));
  f.control.status = "COMPLETED";
  assert.equal(
    data(
      await f.client.callTool({ name: "payout_status", arguments: { payoutId: quote.payoutId } }),
    ).result?.state,
    "provider_completed",
  );
  await f.client.callTool({ name: "execute_payout", arguments: { payoutId: quote.payoutId } });
  assert.equal(f.transfers.length, 1);
  assert.equal(f.prompts.length, 1);
  const history = JSON.stringify(
    await f.client.callTool({ name: "payout_history", arguments: {} }),
  );
  assert.equal(history.includes(bank.accountNumber), false);
  assert.equal(history.includes("depositAddress"), false);
});

test("declined human approval leaves the payout prepared and sends no transfer", async (t) => {
  const f = await setup(t, true, false);
  const quote = data(
    await f.client.callTool({
      name: "prepare_payout",
      arguments: { amount: "10", currency: "USDC", bank: input },
    }),
  ).result!;
  assert.equal(
    data(
      await f.client.callTool({ name: "execute_payout", arguments: { payoutId: quote.payoutId } }),
    ).error?.code,
    "APPROVAL_REQUIRED",
  );
  assert.equal(f.store.live(String(quote.payoutId)).state, "prepared");
  assert.equal(f.transfers.length, 0);
});

test("clients without forms can prepare but cannot approve through tool arguments", async (t) => {
  const f = await setup(t, false);
  const quote = data(
    await f.client.callTool({
      name: "prepare_payout",
      arguments: { amount: "10", currency: "USDC", bank: input },
    }),
  ).result!;
  assert.equal(
    (
      await f.client.callTool({
        name: "execute_payout",
        arguments: { payoutId: quote.payoutId, confirmed: true },
      })
    ).isError,
    true,
  );
  assert.equal(
    data(
      await f.client.callTool({ name: "execute_payout", arguments: { payoutId: quote.payoutId } }),
    ).error?.code,
    "HUMAN_APPROVAL_UNAVAILABLE",
  );
  assert.equal(f.transfers.length, 0);
});

test("readiness is accessible without approval and rejects credentials in arguments", async (t) => {
  let checks = 0;
  const f = await setup(t, false, false, async () => {
    checks++;
    return { livePayoutsAvailable: true };
  });
  assert.equal(
    data(await f.client.callTool({ name: "get_readiness", arguments: {} })).result
      ?.livePayoutsAvailable,
    true,
  );
  assert.equal(
    (
      await f.client.callTool({
        name: "get_readiness",
        arguments: { apiKey: "do-not-send-secrets" },
      })
    ).isError,
    true,
  );
  assert.equal(checks, 1);
  assert.equal(f.prompts.length, 0);
});

test("the stdio CLI preserves completed payouts and recipients across restarts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-stdio-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, join(dir, "offramp-live-production-mainnet.sqlite"));
  const quote = await f.service.prepare({ amount: "10", currency: "USDC" });
  await f.service.execute(quote.payoutId, async () => true);
  f.control.status = "COMPLETED";
  await f.service.status(quote.payoutId);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^(OFFRAMP_|PAJ_|CIRCLE_|ARC_)/.test(entry[0]),
    ),
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = new Client({ name: "stdio-restart-test", version: "1" }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/cli.ts"],
        env: { ...env, OFFRAMP_DATA_DIR: dir, CIRCLE_ARC_ADDRESS: source },
        stderr: "pipe",
      }),
    );
    try {
      assert.equal(
        data(
          await client.callTool({ name: "payout_status", arguments: { payoutId: quote.payoutId } }),
        ).result?.state,
        "provider_completed",
      );
      assert.equal(
        data(await client.callTool({ name: "get_default_bank", arguments: {} })).result
          ?.accountEnding,
        "6789",
      );
      assert.equal(
        JSON.stringify(await client.callTool({ name: "payout_history", arguments: {} })).includes(
          bank.accountNumber,
        ),
        false,
      );
    } finally {
      await client.close();
    }
  }
  assert.equal(f.transfers.length, 1);
});
