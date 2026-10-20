export const SERVICE_PREFIX = "naira-offramp-service/v1";

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 512) throw new Error("Invalid encoding");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  if (base64url(bytes) !== value) throw new Error("Noncanonical encoding");
  return bytes;
}

export async function sha256(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function requestMessage(
  method: string,
  url: string,
  timestamp: string,
  nonce: string,
  body: string,
): Promise<string> {
  const target = new URL(url);
  return [
    SERVICE_PREFIX,
    method.toUpperCase(),
    target.origin,
    target.pathname + target.search,
    timestamp,
    nonce,
    await sha256(body),
  ].join("\n");
}
