import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { OfframpError } from "../src/errors.js";
import { decimal, sameName, units } from "../src/money.js";

test("simulation or misspelled modes cannot start a server that moves real funds", () => {
  for (const mode of ["demo", "typo"]) {
    assert.throws(
      () => loadConfig({ OFFRAMP_MODE: mode }),
      (error: unknown) => error instanceof OfframpError && error.code === "INVALID_CONFIG",
    );
  }
  assert.equal(loadConfig({}).mode, "live");
});

test("USDC round-trips exactly at six decimals without floating point arithmetic", () => {
  for (const value of ["0.000001", "10.123456", "100", "999999999999999999.123456"])
    assert.equal(decimal(units(value)), value);
  assert.equal(decimal(units("1349.22", 2), 2), "1349.22");
});

test("holder matching accepts reordered names and rejects missing or different names", () => {
  assert.equal(sameName("TEST EXAMPLE USER", "user test example"), true);
  assert.equal(sameName("TEST EXAMPLE USER", "TEST USER"), false);
  assert.equal(sameName("TEST USER", "OTHER USER"), false);
  assert.equal(sameName("", ""), false);
});

test("hosted endpoints require HTTPS and cannot contain credentials or an arbitrary path", () => {
  for (const url of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/v1",
    "https://example.com?key=secret",
    "ftp://example.com",
  ]) {
    assert.throws(
      () => loadConfig({ OFFRAMP_BACKEND_URL: url }),
      (error) => error instanceof OfframpError && error.code === "INVALID_CONFIG",
    );
  }
  assert.equal(
    loadConfig({ OFFRAMP_BACKEND_URL: "https://example.com/" }).backendUrl,
    "https://example.com",
  );
  assert.equal(
    loadConfig({ OFFRAMP_BACKEND_URL: "http://127.0.0.1:8787" }).backendUrl,
    "http://127.0.0.1:8787",
  );
});
