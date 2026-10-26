import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { requireThat } from "./errors.js";
import { decimal, units } from "./money.js";
import type { ReceiptArtifact, ReceiptRecord } from "./receipt-types.js";

export function receiptId(value: string) {
  requireThat(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), "INVALID_RECEIPT_ID", "Use the local funding or payout ID.");
  return value;
}

export function arcExplorerUrl(hash: string) {
  requireThat(/^0x[0-9a-f]{64}$/i.test(hash), "INVALID_RECEIPT_HASH", "A receipt requires a valid Arc transaction hash.");
  return `https://explorer.arc.io/tx/${hash}`;
}

function clean(value: string, maximum = 160) {
  requireThat(typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value), "INVALID_RECEIPT_DATA", "Receipt fields must be bounded text without control characters.");
  return value;
}

function balanceUnits(value: string) { return /^0(?:\.0{1,6})?$/.test(value) ? 0n : units(value); }

export function receiptBalanceDelta(record: ReceiptRecord) {
  if (record.balanceBeforeUsdc === undefined || record.balanceAfterUsdc === undefined) return undefined;
  const change = balanceUnits(record.balanceAfterUsdc) - balanceUnits(record.balanceBeforeUsdc);
  return `${change < 0n ? "-" : change > 0n ? "+" : ""}${decimal(change < 0n ? -change : change)}`;
}

export function renderReceipt(record: ReceiptRecord): { text: string; svg: string } {
  receiptId(record.id);
  requireThat(record.kind === "funding" || record.kind === "payout", "INVALID_RECEIPT_DATA", "Use a completed funding or payout record.");
  requireThat(record.pajStatus === "COMPLETED", "RECEIPT_NOT_READY", "Receipts are available only after PAJ reports completion.");
  clean(record.providerOrderId, 128);
  requireThat(/^0x[0-9a-f]{40}$/i.test(record.walletAddress) && !/^0x0{40}$/i.test(record.walletAddress), "INVALID_RECEIPT_DATA", "The receipt must identify the existing Arc wallet.");
  const timestamp = new Date(record.timestamp);
  requireThat(Number.isFinite(timestamp.getTime()) && ["Arc block", "Completion observed", "Order created"].includes(record.timestampSource), "INVALID_RECEIPT_DATA", "The receipt timestamp and its source are required.");
  const date = timestamp.toISOString();
  const ngn = decimal(units(record.amountNgn, 2), 2);
  const usdc = decimal(units(record.amountUsdc));
  requireThat(["confirmed", "pending", "failed", "mismatch", "unavailable", "not_recorded"].includes(record.arc.status), "INVALID_RECEIPT_DATA", "The Arc verification state is invalid.");
  if (record.transactionHash) arcExplorerUrl(record.transactionHash);
  requireThat(record.explorerUrl === undefined || (record.transactionHash !== undefined && record.explorerUrl === arcExplorerUrl(record.transactionHash)), "INVALID_RECEIPT_URL", "Receipt links must point to the matching transaction on the Arc explorer.");
  if (record.arc.status === "confirmed") {
    requireThat(record.transactionHash && record.arc.blockNumber && /^\d+$/.test(record.arc.blockNumber) && record.arc.confirmations && /^[1-9]\d*$/.test(record.arc.confirmations), "INVALID_RECEIPT_DATA", "Confirmed Arc evidence requires a transaction, block and confirmation count.");
  }
  if (record.arc.blockHash) requireThat(/^0x[0-9a-f]{64}$/i.test(record.arc.blockHash), "INVALID_RECEIPT_DATA", "The Arc block hash is invalid.");
  if (record.arc.blockNumber) requireThat(/^\d{1,30}$/.test(record.arc.blockNumber), "INVALID_RECEIPT_DATA", "The Arc block number is invalid.");
  if (record.arc.confirmations) requireThat(/^\d{1,30}$/.test(record.arc.confirmations), "INVALID_RECEIPT_DATA", "The Arc confirmation count is invalid.");
  for (const value of [record.balanceBeforeUsdc, record.balanceAfterUsdc]) if (value !== undefined) balanceUnits(value);
  if (record.balanceObservedAt) requireThat(Number.isFinite(Date.parse(record.balanceObservedAt)), "INVALID_RECEIPT_DATA", "The balance observation timestamp is invalid.");
  if (record.recipient) {
    clean(record.recipient.name); clean(record.recipient.bank, 120);
    requireThat(/^\d{4}$/.test(record.recipient.accountEnding), "INVALID_RECEIPT_DATA", "Only the last four bank-account digits belong in a receipt.");
  }
  const grouped = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const [whole, fraction = ""] = ngn.split(".");
  const ngnDisplay = `NGN ${grouped(whole!)}.${fraction.padEnd(2, "0")}`;
  const delta = receiptBalanceDelta(record);
  const walletStatus = record.kind === "payout" ? "Not applicable - payout from wallet" : record.arc.status === "confirmed" ? "Verified by Arc transfer logs" : "Not independently verified";
  const arcStatus = { confirmed: "Confirmed - matching USDC transfer", pending: "Pending confirmation", failed: "Failed transaction", mismatch: "Evidence mismatch - investigate", unavailable: "Verification unavailable", not_recorded: "Transaction hash not recorded" }[record.arc.status];
  const rows: [string, string][] = [
    ["Receipt ID", record.id], ["PAJ order", record.providerOrderId], ["Direction", record.kind === "funding" ? "NGN to Arc USDC" : "Arc USDC to NGN"],
    ["NGN amount", ngnDisplay], ["USDC amount", `${usdc} USDC`], ["PAJ status", "COMPLETED (provider reported)"], ["Wallet credit", walletStatus], ["Arc transaction", arcStatus],
    ["Balance change", delta === undefined ? "Not recorded" : `${delta} USDC (observed)`],
  ];
  if (record.balanceBeforeUsdc !== undefined) rows.push(["Balance before", `${record.balanceBeforeUsdc} USDC`]);
  if (record.balanceAfterUsdc !== undefined) rows.push(["Balance at check", `${record.balanceAfterUsdc} USDC`]);
  if (record.balanceObservedAt) rows.push(["Balance checked", new Date(record.balanceObservedAt).toISOString()]);
  if (record.kind === "payout") rows.push(["Bank credit", "Not independently verified"]);
  if (record.recipient) rows.push(["Recipient", record.recipient.name], ["Bank", `${record.recipient.bank} / ending ${record.recipient.accountEnding}`]);
  rows.push(["Wallet address", record.walletAddress], ["Timestamp UTC", date], ["Time source", record.timestampSource], ["Transaction hash", record.transactionHash ?? "Not recorded"]);
  if (record.arc.blockNumber) rows.push(["Arc block", record.arc.blockNumber]);
  if (record.arc.confirmations) rows.push(["Confirmations", record.arc.confirmations]);
  const note = record.kind === "payout" ? "PAJ completion does not independently establish recipient bank credit." : "Balance change is an observation; Arc logs verify the order's transfer.";
  const width = 88;
  const wrap = (value: string, size: number) => {
    const chars = Array.from(value);
    const lines: string[] = [];
    while (chars.length > size) {
      const space = chars.slice(0, size + 1).lastIndexOf(" ");
      lines.push(chars.splice(0, space > size / 2 ? space : size).join(""));
      if (chars[0] === " ") chars.shift();
    }
    return [...lines, chars.join("")];
  };
  const body = [`AGENT FIAT MCP | ${record.kind === "funding" ? "FUNDING" : "PAYOUT"} RECEIPT`, "", ...rows.flatMap(([key, value]) => wrap(value, width - 21).map((line, index) => `${index === 0 ? `${key}:` : ""}`.padEnd(21) + line)), "", ...wrap(note, width)];
  const text = ["+" + "-".repeat(width + 2) + "+", ...body.map(line => `| ${line.padEnd(width)} |`), "+" + "-".repeat(width + 2) + "+", ...(record.explorerUrl ? [`Explorer: ${record.explorerUrl}`] : [])].join("\n");
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
  let y = 326;
  const parts: string[] = [];
  for (const [key, value] of rows) {
    const monospace = ["Receipt ID", "PAJ order", "Transaction hash", "Wallet address"].includes(key);
    const lines = wrap(value, monospace ? 46 : 31);
    const color = (key === "Wallet credit" && record.kind === "funding" && record.arc.status === "confirmed") || (key === "Arc transaction" && record.arc.status === "confirmed") ? "#137547" : /Not recorded|Not independently|unavailable|mismatch|Failed|Pending/.test(value) ? "#925f00" : "#0a0a0a";
    parts.push(`<text x="40" y="${y}" class="label">${escape(key)}</text>`);
    lines.forEach((line, index) => parts.push(`<text x="220" y="${y + index * 23}" fill="${color}" class="${monospace ? "mono" : "value"}">${escape(line)}</text>`));
    y += Math.max(1, lines.length) * 23 + 21;
    parts.push(`<path d="M40 ${y - 22}H720" stroke="#e5e5e5"/>`);
  }
  const footer = wrap(note, 83);
  const linkY = y + 18;
  const height = y + 58 + footer.length * 21 + (record.explorerUrl ? 34 : 0);
  const headline = record.kind === "funding" ? `${usdc} USDC` : ngnDisplay;
  const subtitle = record.kind === "funding" ? `${ngnDisplay} bank transfer` : `${usdc} USDC transferred to PAJ`;
  const amountFontSize = Math.min(56, Math.floor(680 / (headline.length * 0.65)));
  const subtitleFontSize = Math.min(19, Math.floor(680 / (subtitle.length * 0.65)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${height}" viewBox="0 0 760 ${height}" role="img" aria-labelledby="title description">
<title id="title">Agent Fiat MCP ${record.kind} receipt ${escape(record.id)}</title>
<desc id="description">${escape(`${ngnDisplay}; ${usdc} USDC; PAJ completed; wallet credit: ${walletStatus}; Arc: ${arcStatus}.`)}</desc>
<style>text{font-family:Arial,Helvetica,sans-serif}.label{font-size:14px;fill:#525252}.value{font-size:16px}.mono{font:15px monospace}.amount{font-size:${amountFontSize}px;font-weight:600;font-variant-numeric:tabular-nums}</style>
<rect width="760" height="${height}" rx="14" fill="#ffffff"/>
<rect x=".5" y=".5" width="759" height="${height - 1}" rx="14" fill="none" stroke="#e5e5e5"/>
<text x="40" y="55" font-size="20" font-weight="600" fill="#0a0a0a">Agent Fiat MCP</text>
<text x="40" y="96" font-size="16" fill="#525252">${record.kind === "funding" ? "Wallet funding receipt" : "Bank payout receipt"}</text>
<text x="40" y="179" class="amount" fill="#0a0a0a">${escape(headline)}</text>
<text x="40" y="218" font-size="${subtitleFontSize}" fill="#525252">${escape(subtitle)}</text>
<rect x="40" y="247" width="234" height="32" rx="16" fill="#f2f2f2"/>
<text x="56" y="268" font-size="13" fill="#0a0a0a">PAJ REPORTED COMPLETION</text>
${parts.join("\n")}
${record.explorerUrl ? `<a href="${escape(record.explorerUrl)}"><text x="40" y="${linkY}" font-size="16" fill="#145cc2" text-decoration="underline">Verify transaction on Arc Explorer</text></a>` : ""}
${footer.map((line, index) => `<text x="40" y="${y + (record.explorerUrl ? 60 : 26) + index * 21}" font-size="13" fill="#525252">${escape(line)}</text>`).join("\n")}
</svg>\n`;
  return { text, svg };
}

export function saveReceipt(dataDir: string, record: ReceiptRecord): ReceiptArtifact {
  const { text, svg } = renderReceipt(record);
  const directory = join(resolve(dataDir), "receipts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  requireThat(!lstatSync(directory).isSymbolicLink(), "INVALID_RECEIPT_DIRECTORY", "The receipt directory must be a private local directory, not a symbolic link.");
  const svgPath = join(directory, `${receiptId(record.id)}.svg`);
  if (!existsSync(svgPath) || lstatSync(svgPath).isSymbolicLink() || readFileSync(svgPath, "utf8") !== svg) {
    const temporary = join(directory, `.${record.id}.${randomUUID()}.tmp`);
    try { writeFileSync(temporary, svg, { mode: 0o600, flag: "wx" }); renameSync(temporary, svgPath); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  return { data: record, text, svgPath };
}
