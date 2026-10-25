import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";

// This isolated script deliberately ignores real provider/wallet configuration.
const dataDir = mkdtempSync(join(tmpdir(), "agent-fiat-demo-"));
const runtime = createRuntime(loadConfig({ OFFRAMP_MODE: "demo", OFFRAMP_DATA_DIR: dataDir }));
try {
  console.log("DEMO ONLY — simulated balance, rate and bank payout. No real money moves.");
  await runtime.service.setDefaultBank({ bank: "Demo Bank", accountNumber: "0000000000", expectedName: "DEMO USER" }, async () => true);
  console.log("Starting balance:", await runtime.service.balance());
  const quote = await runtime.service.prepare({ amount: "15000", currency: "NGN" });
  console.log("Prepared quote:", quote);
  const completed = await runtime.service.execute(quote.payoutId, async () => true);
  console.log("Simulated result:", completed);
  console.log("Remaining simulated balance:", await runtime.service.balance());
} finally { runtime.close(); rmSync(dataDir, { recursive: true, force: true }); }
