import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CircleAgent } from "../src/adapters/circle.js";
import { OfframpError, publicError } from "../src/errors.js";

const address = "0x1111111111111111111111111111111111111111";

function fakeCircle(t: test.TestContext, version = "1.2.1", fail = false) {
  const dir = mkdtempSync(join(tmpdir(), "offramp-fake-cli-"));
  const binary = join(dir, "circle.mjs");
  const log = join(dir, "args.json");
  writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
if (${fail}) { console.error('test-secret-never-return'); process.exit(1); }
console.log(JSON.stringify({ data: { signature: '0x1234abcd' } }));
`);
  chmodSync(binary, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { agent: new CircleAgent(binary, address), log };
}

test("Circle signing uses the configured agent wallet on ARC and preserves typed data as one literal argument", async t => {
  const { agent, log } = fakeCircle(t);
  const typedData = { message: { memo: "quotes ' \" and $(not-a-command) `not-a-command`" } };
  assert.equal(await agent.signTypedData(typedData), "0x1234abcd");
  const args = JSON.parse(readFileSync(log, "utf8"));
  assert.deepEqual(args, ["wallet", "sign", "typed-data", JSON.stringify(typedData), "--address", address, "--chain", "ARC", "--output", "json"]);
});

test("outdated Circle CLI is rejected before requesting a signature", async t => {
  const { agent } = fakeCircle(t, "0.0.1");
  await assert.rejects(agent.signTypedData({}), (error: unknown) => error instanceof OfframpError && error.code === "CIRCLE_VERSION");
});

test("Circle stderr and provider bodies cannot leak through public tool errors", async t => {
  const { agent } = fakeCircle(t, "1.2.1", true);
  try { await agent.signTypedData({}); assert.fail("Expected CLI failure"); }
  catch (error) {
    const exposed = publicError(error);
    assert.equal(exposed.code, "CIRCLE_ERROR");
    assert.equal(JSON.stringify(exposed).includes("test-secret-never-return"), false);
  }
  assert.equal(JSON.stringify(publicError(new Error("test-secret-never-return"))).includes("test-secret-never-return"), false);
});
