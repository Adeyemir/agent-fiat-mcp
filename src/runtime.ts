import { join } from "node:path";
import { DemoProvider, DemoSettlement } from "./adapters/demo.js";
import { loadConfig, type Config } from "./config.js";
import { LiveService } from "./live-service.js";
import { PayoutService } from "./service.js";
import { Store } from "./store.js";
import { FundingService } from "./funding-service.js";

export function createRuntime(config: Config = loadConfig()) {
  if (config.mode === "live") {
    const store = new Store(join(config.dataDir, `offramp-live-${config.pajEnvironment}-${config.arcNetwork}.sqlite`));
    return { config, store, service: new LiveService(config, store), funding: new FundingService(config, store), close: () => store.close() };
  }
  const store = new Store(join(config.dataDir, "offramp.sqlite"));
  const service = new PayoutService("demo", new DemoProvider(store), new DemoSettlement(store), store, config.maximumUnits);
  return { config, store, service, funding: undefined, close: () => store.close() };
}
