import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OfframpError, requireThat } from "../errors.js";
import { readLimitedJson, record } from "../http.js";
import { requestMessage } from "../hosted-protocol.js";
import type { ProviderTransport } from "./paj.js";

function identity(dataDir: string): KeyObject {
  const file = join(dataDir, "service-identity.json");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
      }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new OfframpError(
        "SERVICE_IDENTITY_ERROR",
        "Could not create the private service connection. Check profile permissions.",
      );
  }
  try {
    const saved = record(JSON.parse(readFileSync(file, "utf8")));
    requireThat(
      saved.version === 1 && typeof saved.privateKey === "string" && saved.privateKey.length <= 512,
      "SERVICE_IDENTITY_ERROR",
      "The private service identity is invalid. Restore its backup; do not replace it while payouts are pending.",
    );
    const key = createPrivateKey({
      key: Buffer.from(saved.privateKey, "base64url"),
      type: "pkcs8",
      format: "der",
    });
    requireThat(
      key.asymmetricKeyType === "ed25519",
      "SERVICE_IDENTITY_ERROR",
      "The service identity uses an unsupported key type.",
    );
    return key;
  } catch {
    throw new OfframpError(
      "SERVICE_IDENTITY_ERROR",
      "Could not read the private service identity. Restore its backup; do not replace it while payouts are pending.",
    );
  }
}

export function hostedTransport(
  backendUrl: string,
  dataDir: string,
  request: typeof fetch = fetch,
): ProviderTransport {
  let key: KeyObject | undefined;
  return async (path, input) => {
    key ??= identity(dataDir);
    const url = `${backendUrl}/v1${path}`;
    const body =
      input === undefined
        ? ""
        : JSON.stringify(
            path === "/offramp" ? { ...record(input), requestId: randomUUID() } : input,
          );
    const method = input === undefined ? "GET" : "POST";
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const publicKey = createPublicKey(key)
      .export({ type: "spki", format: "der" })
      .toString("base64url");
    const signature = sign(
      null,
      Buffer.from(await requestMessage(method, url, timestamp, nonce, body)),
      key,
    ).toString("base64url");
    try {
      const response = await request(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(40_000),
        headers: {
          "content-type": "application/json",
          "x-offramp-key": publicKey,
          "x-offramp-time": timestamp,
          "x-offramp-nonce": nonce,
          "x-offramp-signature": signature,
        },
        ...(body ? { body } : {}),
      });
      const result = await readLimitedJson(response);
      if (!response.ok) {
        const error = record(record(result).error);
        const codes = [
          "SERVICE_RATE_LIMIT",
          "SERVICE_UNAVAILABLE",
          "ORDER_PREPARATION_UNCERTAIN",
          "ORDER_NOT_FOUND",
          "REQUEST_CONFLICT",
        ];
        const code =
          typeof error.code === "string" && codes.includes(error.code)
            ? error.code
            : "HOSTED_REQUEST_FAILED";
        throw new OfframpError(
          code,
          "The hosted payout service could not complete the request. Check readiness or the existing payout status; do not automatically retry a payment.",
        );
      }
      return result;
    } catch (error) {
      if (error instanceof OfframpError) throw error;
      throw new OfframpError(
        "HOSTED_CONNECTION_FAILED",
        "The hosted service did not respond. Check the connection and existing payout status; no automatic retry was made.",
      );
    }
  };
}
