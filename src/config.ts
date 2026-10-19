import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { units } from "./money.js";
import { requireThat } from "./errors.js";
import type { Mode } from "./types.js";

export interface Config {
  mode: Mode; dataDir: string; maximumUnits: bigint; circleBin: string;
  arcAddress?: string; pajToken?: string; verifiedSettlement: boolean;
  providerMinNgn: bigint; providerMaxNgn: bigint;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.OFFRAMP_MODE ?? "demo";
  requireThat(mode === "demo" || mode === "live", "INVALID_CONFIG", "OFFRAMP_MODE must be demo or live.");
  const min = env.PAJ_MIN_NGN ?? "1000";
  const max = env.PAJ_MAX_NGN ?? "5000000";
  requireThat(/^[1-9]\d*$/.test(min) && /^[1-9]\d*$/.test(max) && BigInt(max) >= BigInt(min), "INVALID_CONFIG", "Configure valid whole-naira PAJ payout limits.");
  return {
    mode,
    dataDir: resolve(env.OFFRAMP_DATA_DIR ?? join(homedir(), ".local", "share", "naira-offramp-mcp")),
    maximumUnits: units(env.OFFRAMP_MAX_USDC ?? "100"), circleBin: env.CIRCLE_BIN ?? "circle",
    ...(env.CIRCLE_ARC_ADDRESS ? { arcAddress: env.CIRCLE_ARC_ADDRESS } : {}),
    ...(env.PAJ_SESSION_TOKEN ? { pajToken: env.PAJ_SESSION_TOKEN } : {}),
    verifiedSettlement: env.PAJ_GATEWAY_SETTLEMENT_VERIFIED === "true",
    providerMinNgn: BigInt(min), providerMaxNgn: BigInt(max),
  };
}
