import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { canonical, DomainError } from "@/domain/primitives";
export interface PrivateDocumentContext { tenantId: string; commissionId: string; operationId: string; purpose: "provider-payout" }
function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new DomainError("PRIVATE_STORE_KEY", "Private payment storage needs its configured application key.", 503, false);
  return Buffer.from(hkdfSync("sha256", secret, "guild.private-payment.v1", "aes-256-gcm", 32));
}
export function sealDocument(value: unknown, context: PrivateDocumentContext): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(canonical(context)));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `g1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}
export function openDocument<T>(encoded: string, context: PrivateDocumentContext): T {
  try {
    const parts = encoded.split(".");
    if (parts.length !== 4 || parts[0] !== "g1" || encoded.length > 1024 * 1024 || !parts.slice(1).every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error("Invalid private document");
    const iv = Buffer.from(parts[1]!, "base64url"), tag = Buffer.from(parts[2]!, "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid private envelope");
    const decipher = createDecipheriv("aes-256-gcm", key(), iv); decipher.setAAD(Buffer.from(canonical(context))); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8")) as T;
  } catch { throw new DomainError("PRIVATE_DOCUMENT_UNREADABLE", "This private payment record could not be authenticated. No new financial request was sent.", 503, false); }
}
