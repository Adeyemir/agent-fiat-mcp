import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { units } from "./money.js";
import { requireThat } from "./errors.js";
import type { Mode } from "./types.js";
import type { PajEnvironment } from "./providers/paj.js";

export interface Config {
  mode: Mode; dataDir: string; maximumUnits: bigint; circleBin: string;
  arcAddress?: string; pajToken?: string; pajApiKey?: string; pajEmail?: string;
  pajEnvironment: PajEnvironment; arcNetwork: "testnet" | "mainnet";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.OFFRAMP_MODE ?? "live";
  requireThat(mode === "demo" || mode === "live", "INVALID_CONFIG", "OFFRAMP_MODE must be demo or live.");
  const pajEnvironment = env.PAJ_ENVIRONMENT ?? "production";
  const arcNetwork = env.ARC_NETWORK ?? "mainnet";
  requireThat(pajEnvironment === "staging" || pajEnvironment === "production", "INVALID_CONFIG", "PAJ_ENVIRONMENT must be staging or production.");
  requireThat(arcNetwork === "testnet" || arcNetwork === "mainnet", "INVALID_CONFIG", "ARC_NETWORK must be testnet or mainnet.");
  return {
    mode,
    dataDir: resolve(env.OFFRAMP_DATA_DIR ?? join(homedir(), ".local", "share", "naira-offramp-mcp")),
    maximumUnits: units(env.OFFRAMP_MAX_USDC ?? "100"), circleBin: env.CIRCLE_BIN ?? "circle",
    ...(env.CIRCLE_ARC_ADDRESS ? { arcAddress: env.CIRCLE_ARC_ADDRESS } : {}),
    ...(env.PAJ_SESSION_TOKEN ? { pajToken: env.PAJ_SESSION_TOKEN } : {}),
    ...(env.PAJ_API_KEY ? { pajApiKey: env.PAJ_API_KEY } : {}),
    ...(env.PAJ_EMAIL ? { pajEmail: env.PAJ_EMAIL } : {}),
    pajEnvironment, arcNetwork,
  };
}
