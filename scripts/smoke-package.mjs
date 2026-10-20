import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "offramp-package-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && !/^(OFFRAMP_|PAJ_|CIRCLE_|ARC_)/.test(key),
  ),
);
env.OFFRAMP_DATA_DIR = join(temp, "profile");
env.CIRCLE_BIN = "must-not-be-called";
const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });

try {
  const [packed] = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp]),
  );
  for (const file of packed.files) {
    assert.ok(
      /^(dist\/|docs\/|package\.json$|\.env\.example$|README\.md$|CONTRIBUTING\.md$|LICENSE$)/.test(
        file.path,
      ),
      `Unexpected package file: ${file.path}`,
    );
  }
  const install = join(temp, "install");
  run("npm", [
    "install",
    "--prefix",
    install,
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    join(temp, packed.filename),
  ]);
  const cwd = join(temp, "unrelated-working-directory");
  mkdirSync(cwd);
  writeFileSync(join(cwd, ".env"), "OFFRAMP_MODE=invalid\nPAJ_API_KEY=must-not-be-loaded\n");
  const binary = join(install, "node_modules", ".bin", metadata.name);
  assert.equal(run(binary, ["--version"], cwd).trim(), metadata.version);
  assert.match(run(binary, ["--help"], cwd), /provider-check/);
  const profile = JSON.parse(run(binary, ["init"], cwd));
  assert.equal(profile.created, true);
  assert.equal(profile.file, join(env.OFFRAMP_DATA_DIR, "provider.env"));
  assert.equal(JSON.parse(run(binary, ["init"], cwd)).created, false);
  const doctor = JSON.parse(run(binary, ["doctor"], cwd));
  assert.equal(doctor.providerConnection, "hosted");
  assert.equal(doctor.providerApiKeyConfigured, undefined);
  assert.equal(doctor.backendUrl, "https://naira-offramp-api.adeyemir215.workers.dev");
  assert.equal(doctor.circleAgentWalletConfigured, false);
  assert.equal(doctor.dataDir, env.OFFRAMP_DATA_DIR);

  const client = new Client({ name: "installed-package-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(
      new StdioClientTransport({ command: binary, args: [], cwd, env, stderr: "pipe" }),
    );
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
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
    const result = await client.callTool({ name: "get_balance", arguments: {} });
    assert.equal(result.structuredContent.error.code, "WALLET_SETUP_REQUIRED");
  } finally {
    await client.close();
  }
  console.log(
    `${metadata.name}@${metadata.version}: packaged install, setup and MCP tools passed.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
