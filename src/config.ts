import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { units } from "./money.js";
import { requireThat } from "./errors.js";
import type { PajEnvironment } from "./providers/paj.js";

export interface Config {
  mode: "live";
  dataDir: string;
  maximumUnits: bigint;
  networkFeeReserveUnits: bigint;
  circleBin: string;
  arcAddress?: string;
  pajApiKey?: string;
  pajEnvironment: PajEnvironment;
  arcNetwork: "testnet" | "mainnet";
}

export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OFFRAMP_DATA_DIR ?? join(homedir(), ".local", "share", "naira-offramp-mcp"));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.OFFRAMP_MODE ?? "live";
  requireThat(
    mode === "live",
    "INVALID_CONFIG",
    "This server uses real funds. Simulation is available only through the automated test fixtures; remove OFFRAMP_MODE or set it to live.",
  );
  const pajEnvironment = env.PAJ_ENVIRONMENT ?? "production";
  const arcNetwork = env.ARC_NETWORK ?? "mainnet";
  requireThat(
    pajEnvironment === "staging" || pajEnvironment === "production",
    "INVALID_CONFIG",
    "PAJ_ENVIRONMENT must be staging or production.",
  );
  requireThat(
    arcNetwork === "testnet" || arcNetwork === "mainnet",
    "INVALID_CONFIG",
    "ARC_NETWORK must be testnet or mainnet.",
  );
  return {
    mode,
    dataDir: dataDirectory(env),
    maximumUnits: units(env.OFFRAMP_MAX_USDC ?? "100"),
    circleBin: env.CIRCLE_BIN ?? "circle",
    networkFeeReserveUnits: units(env.OFFRAMP_NETWORK_FEE_RESERVE_USDC ?? "0.05"),
    ...(env.CIRCLE_ARC_ADDRESS ? { arcAddress: env.CIRCLE_ARC_ADDRESS } : {}),
    ...(env.PAJ_API_KEY ? { pajApiKey: env.PAJ_API_KEY } : {}),
    pajEnvironment,
    arcNetwork,
  };
}
