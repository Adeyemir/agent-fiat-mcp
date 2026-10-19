import { join } from "node:path";
import { DemoProvider, DemoSettlement } from "./adapters/demo.js";
import { loadConfig, type Config } from "./config.js";
import { OfframpError } from "./errors.js";
import { PayoutService } from "./service.js";
import { Store } from "./store.js";

export function createRuntime(config: Config = loadConfig()) {
  if (config.mode !== "demo") {
    throw new OfframpError("LIVE_ROUTE_UNAVAILABLE", "Live Arc-to-NGN settlement is not implemented or verified in this release. Use OFFRAMP_MODE=demo to test the MCP flow. A configuration flag cannot enable live payouts.");
  }
  const store = new Store(join(config.dataDir, "offramp.sqlite"));
  const service = new PayoutService("demo", new DemoProvider(store), new DemoSettlement(store), store, config.maximumUnits);
  return { config, store, service, close: () => store.close() };
}
