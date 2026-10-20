import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { LiveService } from "./live-service.js";
import { Store } from "./store.js";

export function createRuntime(config: Config = loadConfig()) {
  const store = new Store(
    join(config.dataDir, `offramp-live-${config.pajEnvironment}-${config.arcNetwork}.sqlite`),
  );
  const service = new LiveService(config, store);
  return { config, store, service, close: () => store.close() };
}
