import { CircleAgent } from "./adapters/circle.js";
import type { Config } from "./config.js";
import { publicError, requireThat } from "./errors.js";
import { jsonRequest } from "./http.js";
import type { JsonRequest } from "./providers/paj.js";
import { createProvider } from "./providers/index.js";

async function inspect<T>(action: () => Promise<T>) {
  try {
    return { ok: true as const, result: await action() };
  } catch (error) {
    return { ok: false as const, error: publicError(error) };
  }
}

export async function inspectReadiness(config: Config, request: JsonRequest = jsonRequest) {
  const provider = createProvider(config, request);
  const [rate, chains, accountAccess, circle] = await Promise.all([
    inspect(() => provider.rate()),
    inspect(() => provider.chains()),
    inspect(async () => {
      const banks = await provider.banks();
      requireThat(
        banks.length > 0,
        "PROVIDER_BANKS_UNAVAILABLE",
        "PAJ did not list a usable Nigerian bank.",
      );
      return { nigerianBanksAccessible: banks.length };
    }),
    config.arcAddress
      ? inspect(async () => {
          const agent = new CircleAgent(config.circleBin, config.arcAddress!, config.arcNetwork);
          const cliVersion = await agent.checkVersion();
          await agent.requireAgentWallet();
          return {
            cliVersion,
            walletAuthenticated: true,
            sourceNetwork: config.arcNetwork,
            walletUsdc: await agent.usdcBalance(),
          };
        })
      : Promise.resolve({
          checked: false as const,
          reason: "No Circle Agent Wallet address configured.",
        }),
  ]);
  const arcOrdersAvailable =
    chains.ok && chains.result.some((chain) => chain.chain === "ARC" && chain.isActive);
  const walletReady = "ok" in circle && circle.ok;
  const livePayoutsAvailable =
    config.mode === "live" &&
    config.arcNetwork === "mainnet" &&
    config.pajEnvironment === "production" &&
    arcOrdersAvailable &&
    accountAccess.ok &&
    rate.ok &&
    walletReady;
  return {
    checkedAt: new Date().toISOString(),
    livePayoutsAvailable,
    source: {
      asset: "USDC",
      chain: "Arc",
      network: config.arcNetwork,
      walletProduct: "Circle Agent Wallet",
      circle,
    },
    provider: {
      name: "PAJ",
      apiVersion: "v2",
      documentation: "https://docs.paj.cash/",
      environment: config.pajEnvironment,
      connection: config.backendUrl ? "hosted" : "direct",
      apiKeyConfigured: config.backendUrl ? undefined : Boolean(config.pajApiKey),
      ...(config.backendUrl ? { backendUrl: config.backendUrl } : {}),
      accountAccess,
      indicativeRate: rate,
      chains,
      arcOrdersAvailable,
      bankReference: "bankCode + accountNumber",
      ngnAmountGuaranteed: false,
    },
    settlement: {
      route: "Circle Agent Wallet on Arc → PAJ Arc order → NGN bank payout",
      networkFeeCapped: false,
    },
    blockers: [
      ...(!accountAccess.ok
        ? [
            {
              code: "PROVIDER_ACCESS_UNVERIFIED",
              message: config.backendUrl
                ? "The hosted payout service is unavailable. Check the connection and try readiness again."
                : "A working PAJ Business API key is required in direct mode.",
            },
          ]
        : []),
      ...(!rate.ok
        ? [{ code: "PROVIDER_RATE_UNAVAILABLE", message: "PAJ did not return a usable NGN rate." }]
        : []),
      ...(!arcOrdersAvailable
        ? [
            {
              code: "PROVIDER_CHAIN_UNVERIFIED",
              message: "The live PAJ chain list has not confirmed Arc is active.",
            },
          ]
        : []),
      ...(!walletReady
        ? [
            {
              code: "WALLET_ACCESS_UNVERIFIED",
              message: "Connect the Circle Agent Wallet before preparing an Arc payout.",
            },
          ]
        : []),
      ...(config.arcNetwork !== "mainnet"
        ? [
            {
              code: "LIVE_NETWORK_UNVERIFIED",
              message:
                "PAJ's documented production Arc route must not be funded with testnet tokens.",
            },
          ]
        : []),
      ...(config.pajEnvironment !== "production"
        ? [
            {
              code: "PROVIDER_ENVIRONMENT_UNVERIFIED",
              message: "PAJ production is required for this integration.",
            },
          ]
        : []),
    ],
  };
}
