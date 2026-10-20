import { join } from "node:path";
import type { Config } from "./config.js";
import { loadProfileConfig } from "./profile.js";
import { LiveService } from "./live-service.js";
import { Store } from "./store.js";

export function createRuntime(config: Config = loadProfileConfig()) {
  const store = new Store(
    join(config.dataDir, `offramp-live-${config.pajEnvironment}-${config.arcNetwork}.sqlite`),
  );
  const service = new LiveService(config, store);
  return { config, store, service, close: () => store.close() };
}
