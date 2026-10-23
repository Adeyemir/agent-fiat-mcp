import type { Address } from "viem";
import { requireThat } from "../errors.js";
import { jsonRequest, record } from "../http.js";
import { decimal, units } from "../money.js";
import type { JsonRequest } from "../providers/paj.js";

// A read-only query for this depositor on Arc. This is not the cross-chain total
// and it does not include USDC still held in the wallet.
export async function arcGatewayBalance(address: Address, network: "testnet" | "mainnet", request: JsonRequest = jsonRequest): Promise<string> {
  const base = network === "mainnet" ? "https://gateway-api.circle.com" : "https://gateway-api-testnet.circle.com";
  const response = record(await request(`${base}/v1/balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ domain: 26, depositor: address }] }),
  }));
  requireThat(response.token === "USDC" && Array.isArray(response.balances) && response.balances.length <= 1, "INVALID_GATEWAY_BALANCE", "Gateway did not return a single Arc source balance.");
  if (response.balances.length === 0) return "0";
  const source = record(response.balances[0]);
  requireThat(source.domain === 26 && typeof source.depositor === "string" && source.depositor.toLowerCase() === address.toLowerCase(), "INVALID_GATEWAY_BALANCE", "Gateway returned a different depositor or source chain.");
  requireThat(typeof source.balance === "string" && source.balance.length <= 30 && /^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(source.balance), "INVALID_GATEWAY_BALANCE", "Gateway returned an invalid USDC balance.");
  return /^0(?:\.0+)?$/.test(source.balance) ? "0" : decimal(units(source.balance));
}
