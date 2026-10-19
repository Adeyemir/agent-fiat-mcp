import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { OfframpError, requireThat } from "./errors.js";
import { record } from "./http.js";
import type { PajSession } from "./providers/paj.js";

function sessionPath(config: Config) { return join(config.dataDir, `paj-session-${config.pajEnvironment}.json`); }

export function savePajSession(config: Config, session: PajSession): void {
  requireThat(session.environment === config.pajEnvironment && Date.parse(session.expiresAt) > Date.now() && typeof session.token === "string" && session.token.length > 0 && session.token.length <= 16_384 && !/\s/.test(session.token), "INVALID_PROVIDER_SESSION", "The PAJ session must be valid and belong to the selected API environment.");
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const temporary = join(config.dataDir, `.paj-session-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(session), { mode: 0o600, flag: "wx" });
  renameSync(temporary, sessionPath(config));
}

export function loadPajSession(config: Config): PajSession | undefined {
  if (!existsSync(sessionPath(config))) return undefined;
  try {
    const data = record(JSON.parse(readFileSync(sessionPath(config), "utf8")));
    requireThat(data.environment === config.pajEnvironment && typeof data.token === "string" && data.token.length > 0 && data.token.length <= 16_384 && !/\s/.test(data.token) && typeof data.expiresAt === "string" && Number.isFinite(Date.parse(data.expiresAt)), "INVALID_PROVIDER_SESSION", "The saved PAJ session is malformed. Authenticate again locally.");
    requireThat(Date.parse(data.expiresAt) > Date.now(), "PROVIDER_SESSION_EXPIRED", "The saved PAJ session has expired. Authenticate again locally with provider:login.");
    return { environment: config.pajEnvironment, token: data.token, expiresAt: data.expiresAt };
  } catch (error) {
    if (error instanceof OfframpError) throw error;
    throw new OfframpError("INVALID_PROVIDER_SESSION", "The saved PAJ session could not be read. Authenticate again locally.");
  }
}

export function pajToken(config: Config): string | undefined { return config.pajToken ?? loadPajSession(config)?.token; }
