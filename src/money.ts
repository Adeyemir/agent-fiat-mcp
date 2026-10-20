import { requireThat } from "./errors.js";

export function units(value: string, decimals = 6): bigint {
  requireThat(
    typeof value === "string" && value.length <= 30,
    "INVALID_AMOUNT",
    "Use an ordinary decimal amount, as text.",
  );
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  requireThat(
    match && (match[2]?.length ?? 0) <= decimals,
    "INVALID_AMOUNT",
    `Use a positive amount with at most ${decimals} decimal places.`,
  );
  const amount =
    BigInt(match[1]!) * 10n ** BigInt(decimals) +
    BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
  requireThat(amount > 0n, "INVALID_AMOUNT", "The amount must be above zero.");
  return amount;
}

export function decimal(amount: bigint, decimals = 6): string {
  requireThat(amount >= 0n, "INVALID_AMOUNT", "An amount cannot be negative.");
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${amount / scale}${fraction ? `.${fraction}` : ""}`;
}

export function sameName(left: string, right: string): boolean {
  const normalise = (s: string) =>
    s
      .toLocaleLowerCase("en")
      .replace(/[^a-z0-9 ]/g, " ")
      .trim()
      .split(/\s+/)
      .sort()
      .join(" ");
  const a = normalise(left);
  return a.length > 0 && a === normalise(right);
}
