import { OfframpError, requireThat } from "./errors.js";

export async function readLimitedText(
  response: Response | Request,
  maximum = 1_048_576,
): Promise<string> {
  const length = response.headers.get("content-length");
  requireThat(
    !length ||
      (Number.isSafeInteger(Number(length)) && Number(length) >= 0 && Number(length) <= maximum),
    "RESPONSE_TOO_LARGE",
    "The request or response exceeds the permitted size.",
  );
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new OfframpError(
          "RESPONSE_TOO_LARGE",
          "The request or response exceeds the permitted size.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readLimitedJson(response: Response): Promise<unknown> {
  return JSON.parse(await readLimitedText(response));
}

export async function jsonRequest(url: string, options: RequestInit = {}): Promise<unknown> {
  try {
    const response = await fetch(url, {
      ...options,
      // Workers rejects redirect:"error". Manual mode never follows redirects;
      // the response.ok check below also rejects every 3xx response.
      redirect: "manual",
      signal: AbortSignal.timeout(35_000),
    });
    if (!response.ok)
      throw new OfframpError(
        "PROVIDER_HTTP_ERROR",
        `A provider request failed (HTTP ${response.status}). Check account access and use payout_status after a payment submission.`,
      );
    return await readLimitedJson(response);
  } catch (error) {
    if (error instanceof OfframpError) throw error;
    throw new OfframpError(
      "NETWORK_ERROR",
      "A provider request did not complete. After a payment submission, check the existing payout; do not send again.",
    );
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new OfframpError("INVALID_RESPONSE", "A provider returned an unexpected response.");
  return value as Record<string, unknown>;
}

export function responseData(value: unknown): Record<string, unknown> {
  const root = record(value);
  return root.data && !Array.isArray(root.data) && typeof root.data === "object"
    ? record(root.data)
    : root;
}
