import { createHash } from "node:crypto";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 409, public recoverable = true) { super(message); this.name = "DomainError"; }
}
export function assertMinor(amount: number) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new DomainError("INVALID_MONEY", "Amounts must be whole nonnegative cents.", 400, false);
}
