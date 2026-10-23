import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAddress, type Address } from "viem";
import { OfframpError, requireThat } from "../errors.js";
import { record, responseData } from "../http.js";
import { decimal, units } from "../money.js";

const exec = promisify(execFile);
const ARC_USDC = "0x3600000000000000000000000000000000000000";

// No shell and no private key. Uses the user's existing Circle agent-wallet session.
export class CircleAgent {
  readonly address: Address;
  readonly chain: "ARC" | "ARC-TESTNET";
  constructor(private readonly binary: string, address: string, network: "testnet" | "mainnet" = "testnet") {
    this.chain = network === "mainnet" ? "ARC" : "ARC-TESTNET";
    try { this.address = getAddress(address); }
    catch { throw new OfframpError("INVALID_CONFIG", "CIRCLE_ARC_ADDRESS must identify your Circle agent wallet on Arc."); }
  }

  async command(args: string[]): Promise<unknown> {
    try {
      const { stdout } = await exec(this.binary, [...args, "--output", "json"], {
        timeout: 90_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, DO_NOT_TRACK: "1" },
      });
      const output: unknown = JSON.parse(stdout);
      const root = record(output);
      requireThat(!root.error, "CIRCLE_ERROR", "Circle rejected the request. Check wallet login, Terms acceptance, permissions and CLI version locally.");
      return output;
    } catch (error) {
      if (error instanceof OfframpError) throw error;
      throw new OfframpError("CIRCLE_ERROR", "Circle CLI did not complete. Use the current CLI and authenticate locally; this server never accepts Terms or logs in for you.");
    }
  }

  async checkVersion() {
    try {
      const { stdout } = await exec(this.binary, ["--version"], { timeout: 10_000, env: { ...process.env, DO_NOT_TRACK: "1" } });
      const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(stdout);
      requireThat(match, "CIRCLE_VERSION", "Could not determine Circle CLI version.");
      const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
      requireThat(major > 1 || (major === 1 && (minor > 2 || (minor === 2 && patch >= 1))), "CIRCLE_VERSION", "Circle CLI 1.2.1 or later is required. Update it locally before enabling live cashouts.");
      return match[0];
    } catch (error) {
      if (error instanceof OfframpError) throw error;
      throw new OfframpError("CIRCLE_VERSION", "Install the current @circle-fin/cli and authenticate locally.");
    }
  }

  async signTypedData(typedData: Record<string, unknown>): Promise<string> {
    await this.checkVersion();
    const data = responseData(await this.command(["wallet", "sign", "typed-data", JSON.stringify(typedData), "--address", this.address, "--chain", this.chain]));
    requireThat(typeof data.signature === "string" && /^0x[0-9a-f]+$/i.test(data.signature), "CIRCLE_SIGNATURE", "Circle did not return a valid signature. No Gateway payment was submitted.");
    return data.signature;
  }

  async usdcBalance(): Promise<string> {
    const data = responseData(await this.command(["wallet", "balance", "--address", this.address, "--chain", this.chain, "--token", ARC_USDC]));
    requireThat(Array.isArray(data.balances) && data.balances.length <= 1, "CIRCLE_BALANCE", "Circle did not return a single Arc USDC token balance.");
    if (data.balances.length === 0) return "0";
    const balance = record(data.balances[0]);
    const token = record(balance.token);
    // Arc's native 18-decimal balance and ERC-20 6-decimal balance are the same
    // funds. Request and accept only the ERC-20 view; never add the two views.
    requireThat(token.symbol === "USDC" && token.blockchain === this.chain && token.decimals === 6 && token.isNative === false && typeof token.tokenAddress === "string" && token.tokenAddress.toLowerCase() === ARC_USDC, "CIRCLE_BALANCE", "Circle returned an unexpected token or source network.");
    requireThat(typeof balance.amount === "string" && balance.amount.length <= 30 && /^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(balance.amount), "CIRCLE_BALANCE", "Circle returned an invalid USDC balance.");
    return /^0(?:\.0+)?$/.test(balance.amount) ? "0" : decimal(units(balance.amount));
  }

  async requireAgentWallet() {
    const data = responseData(await this.command(["wallet", "list", "--chain", this.chain, "--type", "agent"]));
    requireThat(Array.isArray(data.wallets) && data.wallets.some(value => { const wallet = record(value); return wallet.type === "agent" && wallet.blockchain === this.chain && typeof wallet.address === "string" && wallet.address.toLowerCase() === this.address.toLowerCase(); }), "AGENT_WALLET_REQUIRED", "The saved source is not an authenticated Circle Agent Wallet on this chain.");
  }

  private transferArguments(to: string, usdc: string) {
    requireThat(/^0x[0-9a-f]{40}$/i.test(to) && !/^0x0{40}$/i.test(to), "INVALID_DESTINATION", "The provider funding address is invalid.");
    return ["wallet", "transfer", getAddress(to), "--amount", decimal(units(usdc)), "--token", ARC_USDC, "--address", this.address, "--chain", this.chain];
  }

  async estimateUsdcTransfer(to: string, usdc: string): Promise<string> {
    const data = responseData(await this.command([...this.transferArguments(to, usdc), "--estimate"]));
    requireThat(data.blockchain === this.chain, "CIRCLE_FEE", "Circle returned a fee for another chain.");
    const fee = record(data.medium).networkFee;
    requireThat(typeof fee === "string" && fee.length <= 40 && /^(0|[1-9]\d*)(?:\.\d{1,18})?$/.test(fee), "CIRCLE_FEE", "Circle returned an invalid Arc USDC network fee.");
    const nativeUnits = /^0(?:\.0+)?$/.test(fee) ? 0n : units(fee, 18);
    // Arc gas is native USDC (18 decimals). Round UP into the six-decimal token
    // view. This is an estimate, not an enforceable CLI gas cap.
    return decimal((nativeUnits + 999_999_999_999n) / 1_000_000_000_000n);
  }

  async transferUsdc(to: string, usdc: string, idempotencyKey: string) {
    requireThat(/^[a-f0-9-]{36}$/i.test(idempotencyKey), "INVALID_TRANSFER_REFERENCE", "Use the persisted payout reference for settlement.");
    const data = responseData(await this.command([...this.transferArguments(to, usdc), "--idempotency-key", idempotencyKey]));
    requireThat(typeof data.id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(data.id) && data.blockchain === this.chain && typeof data.sourceAddress === "string" && data.sourceAddress.toLowerCase() === this.address.toLowerCase() && typeof data.destinationAddress === "string" && data.destinationAddress.toLowerCase() === to.toLowerCase() && Array.isArray(data.amounts) && data.amounts.length === 1 && typeof data.amounts[0] === "string" && units(data.amounts[0], 18) === units(usdc) * 1_000_000_000_000n && ["CONFIRMED", "COMPLETE"].includes(String(data.state)), "CIRCLE_TRANSFER_UNCERTAIN", "Circle did not return a matching confirmed transfer. Reconcile this payout before taking further action.");
    return { id: data.id, ...(typeof data.txHash === "string" && /^0x[0-9a-f]{64}$/i.test(data.txHash) ? { txHash: data.txHash } : {}) };
  }
}
