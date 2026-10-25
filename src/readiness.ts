import { CircleAgent } from "./adapters/circle.js";
import { arcGatewayBalance } from "./adapters/gateway.js";
import type { Config } from "./config.js";
import { publicError, requireThat } from "./errors.js";
import { jsonRequest } from "./http.js";
import { PajClient, PAJ_DOCUMENTED_CHAINS, type JsonRequest } from "./providers/paj.js";

async function inspect<T>(action: () => Promise<T>) {
  try { return { ok: true as const, result: await action() }; }
  catch (error) { return { ok: false as const, error: publicError(error) }; }
}

// Read-only v2 account checks. Gateway is optional diagnostics, not part of the
// direct Arc payment route. No registration, order or transfer is submitted.
export async function inspectReadiness(config: Config, request: JsonRequest = jsonRequest) {
  const provider = new PajClient(config.pajEnvironment, config.pajApiKey, request);
  const [rate, onrampRate, chains, accountAccess, circle] = await Promise.all([
    inspect(() => provider.rate()),
    inspect(() => provider.rate("onRamp")),
    inspect(() => provider.chains()),
    inspect(async () => {
      const banks = await provider.banks();
      requireThat(banks.length > 0, "PROVIDER_BANKS_UNAVAILABLE", "PAJ did not list a usable Nigerian bank.");
      return { nigerianBanksAccessible: banks.length };
    }),
    config.arcAddress ? inspect(async () => {
      const agent = new CircleAgent(config.circleBin, config.arcAddress!, config.arcNetwork);
      const cliVersion = await agent.checkVersion();
      await agent.requireAgentWallet();
      const [walletUsdc, gatewayArcUsdc] = await Promise.all([agent.usdcBalance(), inspect(() => arcGatewayBalance(agent.address, config.arcNetwork, request))]);
      return { cliVersion, walletAuthenticated: true, sourceNetwork: config.arcNetwork, walletUsdc, gatewayArcUsdc, diagnosticOnly: true, simulated: false };
    }) : Promise.resolve({ checked: false as const, reason: "No Circle Agent Wallet address configured." }),
  ]);
  const arcOrdersAvailable = chains.ok && chains.result.some(chain => chain.chain === "ARC" && chain.isActive);
  const walletReady = "ok" in circle && circle.ok;
  const livePayoutsAvailable = config.mode === "live" && config.arcNetwork === "mainnet" && config.pajEnvironment === "production" && arcOrdersAvailable && accountAccess.ok && rate.ok && walletReady;
  return {
    checkedAt: new Date().toISOString(), mode: config.mode, livePayoutsAvailable, payoutExecutionImplemented: true, livePayoutsVerified: false,
    source: { asset: "USDC", chain: "Arc", network: config.arcNetwork, walletProduct: "Circle Agent Wallet", circle },
    provider: {
      name: "PAJ", apiVersion: "v2", documentation: "https://docs.paj.cash/", environment: config.pajEnvironment,
      apiKeyConfigured: Boolean(config.pajApiKey), loginRequired: false, accountAccess,
      indicativeRate: rate, indicativeOnrampRate: onrampRate, chains, arcOrdersAvailable,
      publishedSettlementChains: PAJ_DOCUMENTED_CHAINS, directArcSettlementDocumented: true,
      bankReference: "bankCode + accountNumber", ngnAmountGuaranteed: false,
    },
    settlement: { route: "Circle Agent Wallet on Arc → PAJ Arc order → NGN bank payout", gatewayRequired: false, networkFeeCapped: false },
    funding: { route: "NGN bank transfer → PAJ onramp order → Circle Agent Wallet USDC on Arc", orderPreparationImplemented: true, manualBankTransferRequired: true, liveFundingVerified: false, walletOwnershipCheckedDuringPreparation: true },
    blockers: [
      ...(!accountAccess.ok ? [{ code: "PROVIDER_ACCESS_UNVERIFIED", message: "A working PAJ Business API key is required for v2. Legacy OTP sessions are not used." }] : []),
      ...(!arcOrdersAvailable ? [{ code: "PROVIDER_CHAIN_UNVERIFIED", message: "The live PAJ chain list has not confirmed Arc is active." }] : []),
      ...(!walletReady ? [{ code: "WALLET_ACCESS_UNVERIFIED", message: "Connect the Circle Agent Wallet before preparing an Arc payout." }] : []),
      ...(config.arcNetwork !== "mainnet" ? [{ code: "LIVE_NETWORK_UNVERIFIED", message: "PAJ's documented production Arc route must not be funded with testnet tokens." }] : []),
    ],
    remainingVerification: { realTransferTested: false, independentBankCreditVerified: false },
  };
}
