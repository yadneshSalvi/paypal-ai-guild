import type { MarketPackage, MarketProvider, OfferThread, OfferTerms, ProviderMarketSnapshot } from "@/contracts/provider-market";
import type { PackageKind } from "@/contracts/guild";

export const WORK_KINDS: { value: PackageKind; label: string }[] = [
  { value: "research", label: "Research" }, { value: "translation", label: "Translation" },
  { value: "narration", label: "Narration" }, { value: "images", label: "Image treatment" },
  { value: "web", label: "Web design" }, { value: "captions", label: "Captions & easy-read" },
];
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const utc = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
export const money = (minor: number) => Number.isSafeInteger(minor) ? usd.format(minor / 100) : "Amount unavailable";
export const dateLabel = (value: string) => Number.isFinite(Date.parse(value)) ? `${utc.format(new Date(value))} UTC` : "Date unavailable";
export const kindLabel = (kind: PackageKind) => WORK_KINDS.find(item => item.value === kind)?.label ?? kind;
export const readable = (value: string) => value.replaceAll("_", " ").replaceAll(".", " · ");
export const shortDigest = (value: string | null) => value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "Not recorded";

/** Decimal strings are parsed as integer cents; a financial input is never rounded. */
export function parseAward(value: string): number | null {
  const match = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= 10_000_000 ? cents : null;
}
export const awardInput = (minor: number) => `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
export function safeHref(value: string | null | undefined): string | null {
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export function studioHref(snapshot: ProviderMarketSnapshot, view?: string): string | null {
  const href = safeHref(snapshot.commission?.studioUrl);
  if (!href || !view) return href;
  const url = new URL(href, "https://guild.invalid");
  url.searchParams.set("view", view);
  return href.startsWith("/") ? `${url.pathname}${url.search}${url.hash}` : url.href;
}
export function expired(value: string, now: number): boolean { return !Number.isFinite(Date.parse(value)) || Date.parse(value) <= now; }
export function quoteUnavailable(provider: MarketProvider, work: MarketPackage | undefined, snapshot: ProviderMarketSnapshot, now: number): string | null {
  if (snapshot.scope !== "buyer") return "Open the customer market to request work.";
  if (!snapshot.commission) return "Open a commission before requesting a quote.";
  if (!work) return "Choose a work package first.";
  if (!work.canRequestQuote) return work.unavailableReason ?? "This package is not open for quotes.";
  if (work.unavailableReason) return work.unavailableReason;
  if (expired(work.workAuthorityExpiresAt, now)) return "This package’s work authority has expired. Review it in Passport.";
  if (!work.allowedProviderIds.includes(provider.id)) return "This provider is outside the package’s current allowlist.";
  if (!provider.kinds.includes(work.kind)) return "This provider does not offer this work type.";
  if (provider.enrollment.state !== "ready") return provider.enrollment.message || "Provider enrollment is incomplete.";
  if (!provider.policy) return "The provider has not published a policy.";
  if (expired(provider.policy.validUntil, now)) return "The provider’s current policy has expired.";
  if (!provider.policy.allowedKinds.includes(work.kind)) return "The provider’s current policy does not allow this work.";
  if (provider.capacity.active + provider.capacity.reserved >= provider.capacity.maximum) return "All current provider capacity is in use.";
  if (snapshot.threads.some(thread => thread.commissionId === snapshot.commission?.id && thread.packageId === work.id && thread.providerId === provider.id && ["requesting", "open", "selected", "needs_review"].includes(thread.state) && (thread.state === "selected" || !thread.latestTerms || !expired(thread.latestTerms.expiresAt, now)))) return "An offer thread for this package is already open below.";
  return null;
}
export function termsUnavailable(thread: OfferThread, now: number): string | null {
  if (thread.unavailableReason) return thread.unavailableReason;
  if (["expired", "superseded", "withdrawn", "declined", "needs_review"].includes(thread.state)) return `This offer is ${readable(thread.state)}.`;
  if (!thread.latestTerms || !thread.latestTermsDigest) return "Waiting for a provider offer.";
  if (expired(thread.latestTerms.expiresAt, now)) return "This quote has expired. Request fresh terms before selecting work.";
  if (expired(thread.latestTerms.workAuthorityExpiresAt, now)) return "The original work authority has expired.";
  return null;
}
export function sameTerms(a: OfferTerms, b: OfferTerms): boolean { return JSON.stringify(a) === JSON.stringify(b); }
export function ownsProvider(snapshot: ProviderMarketSnapshot, provider: MarketProvider): boolean {
  return snapshot.scope === "provider" && snapshot.viewer.providerId === provider.id && snapshot.viewer.canManageProvider && provider.enrollment.canEdit;
}
