import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProfile, loadProfileConfig, profileFile } from "../src/profile.js";
import { OfframpError } from "../src/errors.js";

const environmentDigest = () =>
  createHash("sha256")
    .update(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");

test("profile initialization creates a private template and never overwrites an existing file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "offramp-profile-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { OFFRAMP_DATA_DIR: join(root, "private") };
  const first = initProfile(env);
  assert.equal(first.created, true);
  assert.equal(first.file, profileFile(env));
  assert.equal(statSync(env.OFFRAMP_DATA_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(first.file).mode & 0o777, 0o600);
  assert.match(readFileSync(first.file, "utf8"), /# CIRCLE_ARC_ADDRESS=/);
  assert.ok(!readFileSync(first.file, "utf8").includes("PAJ_API_KEY="));
  writeFileSync(first.file, "PAJ_API_KEY=existing-private-key\n");
  assert.deepEqual(initProfile(env), { file: first.file, created: false });
  assert.equal(readFileSync(first.file, "utf8"), "PAJ_API_KEY=existing-private-key\n");
});

test("profile configuration honors explicit environment overrides without changing process.env", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-profile-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    profileFile({ OFFRAMP_DATA_DIR: dir }),
    [
      "PAJ_API_KEY=saved-private-key",
      "CIRCLE_ARC_ADDRESS=0x1111111111111111111111111111111111111111",
      "OFFRAMP_MAX_USDC=20",
      "OFFRAMP_DATA_DIR=/must-not-redirect-the-profile",
      "NODE_OPTIONS=--must-not-change-child-processes",
    ].join("\n"),
  );
  const before = environmentDigest();
  const config = loadProfileConfig({
    OFFRAMP_DATA_DIR: dir,
    OFFRAMP_MAX_USDC: "5",
    PAJ_API_KEY: undefined,
  });
  assert.equal(config.pajApiKey, "saved-private-key");
  assert.equal(config.arcAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(config.maximumUnits, 5_000_000n);
  assert.equal(config.dataDir, dir);
  assert.equal(loadProfileConfig({ OFFRAMP_DATA_DIR: dir, PAJ_API_KEY: "" }).pajApiKey, undefined);
  assert.equal(environmentDigest(), before, "Profile loading must not mutate process.env.");
});

test("missing profile files allow environment configuration, while unreadable profiles fail safely", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-profile-read-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { OFFRAMP_DATA_DIR: dir, PAJ_API_KEY: "environment-private-key" };
  assert.equal(loadProfileConfig(env).pajApiKey, env.PAJ_API_KEY);
  mkdirSync(profileFile(env));
  assert.throws(
    () => loadProfileConfig(env),
    (error: unknown) => error instanceof OfframpError && error.code === "INVALID_CONFIG",
  );
});

test("a saved simulation profile cannot start a runtime using real funds", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "offramp-profile-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(profileFile({ OFFRAMP_DATA_DIR: dir }), "OFFRAMP_MODE=demo\n");
  assert.throws(
    () => loadProfileConfig({ OFFRAMP_DATA_DIR: dir }),
    (error: unknown) => error instanceof OfframpError && error.code === "INVALID_CONFIG",
  );
});
