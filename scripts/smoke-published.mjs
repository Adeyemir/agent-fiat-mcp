import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Run this check on a GitHub Actions runner.");
const version = process.env.OFFRAMP_NPM_VERSION;
assert.match(version ?? "", /^\d+\.\d+\.\d+$/, "Provide an exact published npm version.");

const temporary = mkdtempSync(join(tmpdir(), "offramp-published-"));
const home = join(temporary, "home");
const cache = join(temporary, "npm-cache");
const cwd = join(temporary, "empty-working-directory");
mkdirSync(home);
mkdirSync(cwd);
const env = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: temporary,
  OFFRAMP_DATA_DIR: join(temporary, "profile"),
  CIRCLE_BIN: "must-not-be-called",
  npm_config_cache: cache,
  npm_config_userconfig: "/dev/null",
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_ignore_scripts: "true",
};
const execute = promisify(execFile);
const args = ["--yes", `naira-offramp-mcp@${version}`];
const run = async (extra) =>
  (
    await execute("npx", [...args, ...extra], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 120_000,
      killSignal: "SIGKILL",
    })
  ).stdout;
const endpoint = "https://naira-offramp-api.adeyemir215.workers.dev";
let client;

try {
  assert.equal((await run(["--version"])).trim(), version);
  assert.equal(JSON.parse(await run(["init"])).created, true);
  const profileBefore = readFileSync(join(env.OFFRAMP_DATA_DIR, "provider.env"), "utf8");
  assert.equal(JSON.parse(await run(["init"])).created, false);
  assert.equal(readFileSync(join(env.OFFRAMP_DATA_DIR, "provider.env"), "utf8"), profileBefore);
  assert.doesNotMatch(profileBefore, /PAJ_API_KEY/);
  const doctor = JSON.parse(await run(["doctor"]));
  assert.equal(doctor.providerConnection, "hosted");
  assert.equal(doctor.backendUrl, endpoint);
  assert.equal(doctor.providerApiKeyConfigured, undefined);
  assert.equal(doctor.circleAgentWalletConfigured, false);

  const installs = readdirSync(join(cache, "_npx"), { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  assert.equal(installs.length, 1);
  const modules = join(cache, "_npx", installs[0].name, "node_modules");
  const published = join(modules, "naira-offramp-mcp");
  const manifest = JSON.parse(readFileSync(join(published, "package.json"), "utf8"));
  assert.equal(manifest.version, version);
  assert.equal(existsSync(join(modules, "@circle-fin", "cli")), false);
  assert.ok(readFileSync(join(published, "docs", "prompts.md"), "utf8").includes("get_readiness"));

  // Load the MCP client from the downloaded package's dependencies, not the checkout.
  const require = createRequire(join(published, "package.json"));
  const { Client } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href
  );
  client = new Client({ name: "published-remote-check", version: "1" }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({ command: "npx", args, cwd, env, stderr: "pipe" }),
  );
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, [
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
  const balance = await client.callTool({ name: "get_balance", arguments: {} });
  assert.equal(balance.structuredContent.error.code, "WALLET_SETUP_REQUIRED");
  const response = await client.callTool({ name: "get_readiness", arguments: {} });
  assert.notEqual(response.isError, true);
  const ready = response.structuredContent.result;
  assert.equal(ready.provider.connection, "hosted");
  assert.equal(ready.provider.indicativeRate.ok, true, "Hosted rate lookup failed.");
  assert.equal(ready.provider.accountAccess.ok, true, "Hosted bank-directory lookup failed.");
  assert.equal(ready.provider.chains.ok, true, "Hosted chain lookup failed.");
  assert.equal(ready.provider.arcOrdersAvailable, true);
  assert.deepEqual(
    ready.blockers.map((blocker) => blocker.code),
    ["WALLET_ACCESS_UNVERIFIED"],
  );
  assert.equal(statSync(join(env.OFFRAMP_DATA_DIR, "service-identity.json")).mode & 0o777, 0o600);

  const result = {
    runtime: "GitHub-hosted Linux runner",
    package: `naira-offramp-mcp@${version}`,
    source: "public npm registry; fresh cache and private profile",
    backend: endpoint,
    mcpTools: tools.length,
    hostedArcRatesAndBankDirectoryAvailable: true,
    pajKeyProvidedByClient: false,
    circleCliInstalledByPackage: false,
    promptGuideIncluded: true,
    existingProfilePreserved: true,
    walletAuthenticationTested: false,
    walletNote:
      "No wallet session was supplied to this runner. Test the existing session in its chat.",
    paymentsCreatedOrFunded: 0,
  };
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Public npm / hosted API check\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`,
    );
  }
} finally {
  await client?.close();
  rmSync(temporary, { recursive: true, force: true });
}
