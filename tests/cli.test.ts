import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, source } from "./fixtures/live.js";

const exec = promisify(execFile);
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !/^(OFFRAMP_|PAJ_|CIRCLE_|ARC_)/.test(entry[0]),
  ),
);
const run = (args: string[], env: Record<string, string> = {}) =>
  exec(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    env: { ...baseEnv, ...env },
  });

test("CLI status and history inspect an existing completed payout without wallet authentication", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-cli-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, join(dir, "offramp-live-production-mainnet.sqlite"));
  const quote = await f.service.prepare({ amount: "10", currency: "USDC" });
  await f.service.execute(quote.payoutId, async () => true);
  f.control.status = "COMPLETED";
  await f.service.status(quote.payoutId);
  const env = {
    OFFRAMP_DATA_DIR: dir,
    CIRCLE_ARC_ADDRESS: source,
    CIRCLE_BIN: "must-not-be-called",
  };
  const status = JSON.parse((await run(["status", quote.payoutId], env)).stdout);
  assert.equal(status.state, "provider_completed");
  const history = JSON.parse((await run(["history"], env)).stdout);
  assert.equal(history[0].payoutId, quote.payoutId);
  assert.equal(f.transfers.length, 1);
});

test("CLI refuses piped approval and one-off recipient entry before opening a profile", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-cli-interactive-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const args of [
    ["approve", "11111111-1111-4111-8111-111111111111"],
    ["quote", "10", "USDC", "--recipient"],
  ]) {
    await assert.rejects(run(args, { OFFRAMP_DATA_DIR: dir }), (error: unknown) => {
      const result = error as { stderr: string };
      const line = result.stderr.split(/\r?\n/).find((entry) => entry.startsWith("{"));
      assert.ok(line, "CLI must emit a structured error");
      assert.equal(JSON.parse(line).code, "INTERACTIVE_TERMINAL_REQUIRED");
      return true;
    });
  }
  assert.equal(existsSync(join(dir, "offramp-live-production-mainnet.sqlite")), false);
});

test("CLI help and version work without loading an invalid payment configuration", async () => {
  const env = { OFFRAMP_MODE: "invalid", CIRCLE_BIN: "must-not-be-called" };
  const { stdout } = await run(["--help"], env);
  for (const command of ["init", "--version", "--recipient", "status <payout-id>", "history"])
    assert.ok(stdout.includes(command));
  assert.equal(stdout.includes("provider-login"), false);
  assert.match((await run(["--version"], env)).stdout.trim(), /^\d+\.\d+\.\d+$/);
});
