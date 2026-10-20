import { CircleAgent } from "./adapters/circle.js";
import { arcGatewayBalance } from "./adapters/gateway.js";
import type { Config } from "./config.js";
import { publicError, requireThat } from "./errors.js";
import { jsonRequest, record } from "./http.js";
import { PajClient, type JsonRequest } from "./providers/paj.js";
import { pajToken } from "./provider-session.js";

async function inspect<T>(action: () => Promise<T>) {
  try { return { ok: true as const, result: await action() }; }
  catch (error) { return { ok: false as const, error: publicError(error) }; }
}

// Every operation here is read-only. This never creates an order, requests an OTP,
// signs an intent, deposits, bridges or transfers funds.
export async function inspectReadiness(config: Config, request: JsonRequest = jsonRequest) {
  let token: string | undefined;
  let sessionError: ReturnType<typeof publicError> | undefined;
  try { token = pajToken(config); } catch (error) { sessionError = publicError(error); }
  const provider = new PajClient(config.pajEnvironment, token, request);
  const gatewayUrl = config.arcNetwork === "mainnet" ? "https://gateway-api.circle.com" : "https://gateway-api-testnet.circle.com";
  const [rate, gateway, accountAccess, circle] = await Promise.all([
    inspect(() => provider.rate()),
    inspect(async () => {
      const response = record(await request(`${gatewayUrl}/v1/info`));
      requireThat(Array.isArray(response.domains), "INVALID_GATEWAY_RESPONSE", "Gateway did not return supported domains.");
      const domains = response.domains.map(record);
      const source = domains.find(domain => domain.domain === 26 && domain.chain === "Arc");
      const network = config.arcNetwork === "mainnet" ? "Mainnet" : "Testnet";
      const available = Boolean(source && source.network === network);
      const destinations = domains.filter(domain => config.arcNetwork === "mainnet" ? domain.network === "Mainnet" : domain.network === "Testnet" || domain.network === "Devnet").map(domain => String(domain.chain).toUpperCase());
      return { arcSourceAvailable: available, providerSettlementOverlap: ["SOLANA", "MONAD"].filter(chain => destinations.includes(chain)), monadAvailable: destinations.includes("MONAD"), checkedAt: new Date().toISOString() };
    }),
    token ? inspect(async () => {
      const banks = await provider.banks();
      requireThat(banks.length > 0, "PROVIDER_BANKS_UNAVAILABLE", "The authenticated PAJ directory did not list a Nigerian bank.");
      return { nigerianBanksAccessible: banks.length };
    }) : Promise.resolve({ ok: false as const, error: sessionError ?? { code: "PROVIDER_LOGIN_REQUIRED", message: "PAJ API access has not been checked. Supply your Business API key locally and run provider:login when available." } }),
    config.arcAddress ? inspect(async () => {
      const agent = new CircleAgent(config.circleBin, config.arcAddress!, config.arcNetwork);
      const cliVersion = await agent.checkVersion();
      const [walletUsdc, gatewayArcUsdc] = await Promise.all([
        agent.usdcBalance(),
        inspect(() => arcGatewayBalance(agent.address, config.arcNetwork, request)),
      ]);
      return { cliVersion, walletAuthenticated: true, sourceNetwork: config.arcNetwork, walletUsdc, gatewayArcUsdc, diagnosticOnly: true, simulated: false };
    }) : Promise.resolve({ checked: false as const, reason: "No Circle Agent Wallet address configured. No wallet login or signature was requested." }),
  ]);

  return {
    checkedAt: new Date().toISOString(), mode: config.mode, livePayoutsAvailable: false,
    source: { asset: "USDC", chain: "Arc", network: config.arcNetwork, walletProduct: "Circle Agent Wallet", circle },
    provider: { name: "PAJ", environment: config.pajEnvironment, sessionConfigured: Boolean(token), accountAccess, indicativeRate: rate, publishedSettlementChains: ["SOLANA", "MONAD"], directArcSettlementDocumented: false },
    gateway,
    blockers: [
      ...(!accountAccess.ok ? [{ code: "PROVIDER_ACCESS_UNVERIFIED", message: "A usable PAJ session and authenticated API access are required; a public rate response does not prove payout eligibility." }] : []),
      { code: "SETTLEMENT_ACCEPTANCE_UNVERIFIED", message: "PAJ must confirm how an Arc-funded settlement is credited to the exact NGN order, including whether a forwarded USDC mint is recognized." },
      { code: "PROVIDER_CONTRACT_UNCONFIRMED", message: "Confirm order expiry, payout limits, bank-reference semantics, final bank-credit evidence, and reconciliation before enabling payments." },
      { code: "LIVE_EXECUTION_UNAVAILABLE", message: "The raw PAJ client is implemented. Live settlement is not wired into the MCP payout runtime; no flag enables it." },
    ],
  };
}
