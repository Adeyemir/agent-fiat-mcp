import { decodeEventLog, parseAbiItem } from "viem";
import { jsonRequest, record } from "../http.js";
import { units } from "../money.js";
import { PAJ_USDC, type JsonRequest } from "../providers/paj.js";
import type { ArcReceiptEvidence, ReceiptKind } from "../receipt-types.js";

export interface ArcTransferRequest { kind: ReceiptKind; transactionHash: string; walletAddress: string; counterparty?: string; amountUsdc: string }
export type ArcReceiptReader = (input: ArcTransferRequest) => Promise<ArcReceiptEvidence>;

export async function readArcReceipt(input: ArcTransferRequest, request: JsonRequest = jsonRequest): Promise<ArcReceiptEvidence> {
  async function rpc(method: string, params: unknown[]) {
    const response = record(await request("https://rpc.mainnet.arc.io", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
    if (response.error || response.id !== 1 || response.jsonrpc !== "2.0" || !("result" in response)) throw new Error("Arc receipt unavailable.");
    return response.result;
  }
  try {
    const [chain, result] = await Promise.all([rpc("eth_chainId", []), rpc("eth_getTransactionReceipt", [input.transactionHash])]);
    if (chain !== "0x13b2") return { status: "mismatch" };
    if (result === null) return { status: "pending" };
    const receipt = record(result);
    if (typeof receipt.transactionHash !== "string" || receipt.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()) return { status: "mismatch" };
    if (receipt.status === "0x0") return { status: "failed" };
    if (receipt.status !== "0x1" || !Array.isArray(receipt.logs) || typeof receipt.blockNumber !== "string" || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber) || typeof receipt.blockHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash)) return { status: "mismatch" };
    const [blockResult, latest] = await Promise.all([rpc("eth_getBlockByNumber", [receipt.blockNumber, false]), rpc("eth_blockNumber", [])]);
    const block = record(blockResult);
    if (typeof block.hash !== "string" || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase() || block.number !== receipt.blockNumber || typeof block.timestamp !== "string" || !/^0x[0-9a-f]+$/i.test(block.timestamp) || typeof latest !== "string" || !/^0x[0-9a-f]+$/i.test(latest) || BigInt(latest) < BigInt(receipt.blockNumber)) return { status: "mismatch" };
    const event = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
    let matching = 0n;
    let walletNet = 0n;
    for (const entry of receipt.logs) {
      const log = record(entry);
      if (typeof log.address !== "string" || log.address.toLowerCase() !== PAJ_USDC.ARC.toLowerCase() || log.removed === true) continue;
      try {
        const decoded = decodeEventLog({ abi: [event], data: log.data as `0x${string}`, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
        const fromWallet = decoded.args.from.toLowerCase() === input.walletAddress.toLowerCase();
        const toWallet = decoded.args.to.toLowerCase() === input.walletAddress.toLowerCase();
        if (toWallet) walletNet += decoded.args.value;
        if (fromWallet) walletNet -= decoded.args.value;
        if (input.kind === "funding" ? toWallet : fromWallet && decoded.args.to.toLowerCase() === input.counterparty?.toLowerCase()) matching += decoded.args.value;
      } catch { continue; }
    }
    const expected = units(input.amountUsdc);
    if (matching !== expected || (input.kind === "funding" && walletNet !== expected)) return { status: "mismatch" };
    return { status: "confirmed", blockNumber: BigInt(receipt.blockNumber).toString(), blockHash: receipt.blockHash, confirmations: (BigInt(latest) - BigInt(receipt.blockNumber) + 1n).toString(), timestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() };
  } catch { return { status: "unavailable" }; }
}
