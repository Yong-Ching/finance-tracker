import { createHash } from "node:crypto";

/**
 * Stable identity for a transaction line, independent of its database row.
 * Manual overrides key off this, so an edit survives deleting and re-importing
 * the statement it came from.
 */
export function dedupeHash(input: {
  accountId: number;
  txnDate: string;
  amountCents: number;
  descriptionRaw: string;
}): string {
  const normDesc = input.descriptionRaw.replace(/\s+/g, " ").trim().toUpperCase();
  return createHash("sha256")
    .update(`${input.accountId}|${input.txnDate}|${input.amountCents}|${normDesc}`)
    .digest("hex");
}

export function fileHash(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}
