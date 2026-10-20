import type { Config } from "../config.js";
import { jsonRequest } from "../http.js";
import { hostedTransport } from "./hosted.js";
import { PajClient, type JsonRequest } from "./paj.js";

export function createProvider(config: Config, request: JsonRequest = jsonRequest): PajClient {
  return new PajClient(
    config.pajEnvironment,
    config.pajApiKey,
    request,
    config.backendUrl ? hostedTransport(config.backendUrl, config.dataDir) : undefined,
  );
}
