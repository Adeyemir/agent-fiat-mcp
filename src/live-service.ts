import { CircleAgent } from "./adapters/circle.js";
import type { Config } from "./config.js";
import { requireThat } from "./errors.js";
import { jsonRequest } from "./http.js";
import { pajToken } from "./provider-session.js";
import { PajClient, type JsonRequest } from "./providers/paj.js";
import type { PayoutService } from "./service.js";
import type { Store } from "./store.js";
import type { BankInput } from "./types.js";

// Real wallet reads and PAJ bank verification. This service has no payment,
// quote or signing methods: an unfinished route cannot fall back to simulation.
export class LiveService {
  readonly mode = "live" as const;
  private readonly bankScope: string;

  constructor(readonly config: Config, private readonly store: Store, private readonly request: JsonRequest = jsonRequest) {
    this.bankScope = `live:${config.pajEnvironment}:${config.arcNetwork}`;
  }

  private provider() {
    return new PajClient(this.config.pajEnvironment, pajToken(this.config), this.request);
  }

  async balance() {
    requireThat(this.config.arcAddress, "WALLET_SETUP_REQUIRED", "Connect your Circle Agent Wallet and save its Arc address in local CIRCLE_ARC_ADDRESS configuration. No simulated balance is substituted.");
    const wallet = new CircleAgent(this.config.circleBin, this.config.arcAddress, this.config.arcNetwork);
    await wallet.checkVersion();
    return {
      mode: this.mode, simulated: false, source: "USDC on Arc", network: this.config.arcNetwork,
      walletUsdc: await wallet.usdcBalance(), spendableUsdc: null, livePayoutsAvailable: false,
    };
  }

  async banks() {
    return { mode: this.mode, simulated: false, provider: "PAJ", environment: this.config.pajEnvironment, banks: await this.provider().banks() };
  }

  defaultBank() {
    const bank = this.store.getBank(this.bankScope);
    return bank ? { mode: this.mode, simulated: false, environment: this.config.pajEnvironment, name: bank.accountName, bank: bank.bankName, accountEnding: bank.accountNumber.slice(-4) } : null;
  }

  async setDefaultBank(input: BankInput, approve: Parameters<PayoutService["setDefaultBank"]>[1]) {
    const bank = await this.provider().verifyBank(input);
    requireThat(await approve({ name: bank.accountName, bank: bank.bankName, accountNumber: bank.accountNumber, simulated: false }), "APPROVAL_REQUIRED", "The default bank account was not changed.");
    // Save the verified recipient locally. A PAJ saved-account reference will
    // only be bound to orders once the provider's bank-reference contract is clear.
    this.store.setBank(this.bankScope, bank);
    return { mode: this.mode, simulated: false, name: bank.accountName, bank: bank.bankName, accountEnding: bank.accountNumber.slice(-4) };
  }
}
