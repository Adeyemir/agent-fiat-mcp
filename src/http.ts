import { OfframpError } from "./errors.js";

export async function jsonRequest(url: string, options: RequestInit = {}): Promise<unknown> {
  try {
    const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new OfframpError("PROVIDER_HTTP_ERROR", `A provider request failed (HTTP ${response.status}). Check account access and use payout_status after a payment submission.`);
    return await response.json();
  } catch (error) {
    if (error instanceof OfframpError) throw error;
    throw new OfframpError("NETWORK_ERROR", "A provider request did not complete. After a payment submission, check the existing payout; do not send again.");
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OfframpError("INVALID_RESPONSE", "A provider returned an unexpected response.");
  return value as Record<string, unknown>;
}

export function responseData(value: unknown): Record<string, unknown> {
  const root = record(value);
  return root.data && !Array.isArray(root.data) && typeof root.data === "object" ? record(root.data) : root;
}
