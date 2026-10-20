import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { dataDirectory, loadConfig, type Config } from "./config.js";
import { OfframpError } from "./errors.js";

export function profileFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(env), "provider.env");
}

export function initProfile(env: NodeJS.ProcessEnv = process.env) {
  const file = profileFile(env);
  try {
    mkdirSync(dataDirectory(env), { recursive: true, mode: 0o700 });
    writeFileSync(file, readFileSync(new URL("../.env.example", import.meta.url)), {
      flag: "wx",
      mode: 0o600,
    });
    return { file, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { file, created: false };
    throw new OfframpError(
      "PROFILE_INIT_FAILED",
      "Could not create the private profile. Check OFFRAMP_DATA_DIR and directory permissions.",
    );
  }
}

export function loadProfileConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let saved: NodeJS.ProcessEnv = {};
  try {
    saved = parseEnv(readFileSync(profileFile(env), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new OfframpError(
        "INVALID_CONFIG",
        "Could not read the private provider.env file. Check its format and permissions.",
      );
    }
  }
  const overrides = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  // Keep credentials out of process.env and select the profile only from the launching environment.
  return loadConfig({ ...saved, ...overrides, OFFRAMP_DATA_DIR: dataDirectory(env) });
}
