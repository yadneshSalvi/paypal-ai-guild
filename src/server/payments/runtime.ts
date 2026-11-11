import { PaymentCore, PostgresDatabase, SandboxPayPalProvider, SqlPaymentStore, type ProviderAdapter, type SandboxConfig, type SandboxCommerceRestGateway } from "@fracture/paypal-core";
import { DomainError } from "@/domain/primitives";
import { GuildPaymentPolicy } from "./policy";
import { merchantFingerprint } from "./repository";

export function sandboxConfig(): SandboxConfig {
  if (process.env.PAYPAL_ENVIRONMENT !== "sandbox" || process.env.PAYPAL_PROJECT_ISOLATED !== "true" || !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) throw new DomainError("SANDBOX_CONFIGURATION", "This studio needs its isolated PayPal sandbox application before checkout.", 503);
  const baseUrl = process.env.PAYPAL_API_BASE_URL ?? "https://api-m.sandbox.paypal.com";
  if (baseUrl !== "https://api-m.sandbox.paypal.com") throw new DomainError("SANDBOX_REQUIRED", "Guild accepts sandbox payment credentials only.", 503, false);
  return { environment: "sandbox", baseUrl, clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET, isolatedProject: "guild" };
}

export type PayoutGateway = Pick<SandboxCommerceRestGateway, "createPayout" | "getPayoutBatch" | "getPayoutItem" | "cancelUnclaimedPayout">;
export interface PaymentRuntime { db: PostgresDatabase; store: SqlPaymentStore; provider: ProviderAdapter; core: PaymentCore; commerce?: PayoutGateway }
export function createPaymentRuntime(provider?: ProviderAdapter): PaymentRuntime {
  if (!process.env.DATABASE_URL) throw new DomainError("PAYMENT_STORE", "The durable payment store is not configured.", 503);
  const db = new PostgresDatabase(process.env.DATABASE_URL), store = new SqlPaymentStore(db);
  const actualProvider = provider ?? new SandboxPayPalProvider(sandboxConfig());
  return { db, store, provider: actualProvider, core: new PaymentCore({ store, provider: actualProvider, policy: new GuildPaymentPolicy(actualProvider, store, merchantFingerprint()) }) };
}
const globalPayment = globalThis as unknown as { guildPaymentRuntime?: PaymentRuntime };
export const paymentRuntime = (): PaymentRuntime => globalPayment.guildPaymentRuntime ??= createPaymentRuntime();
