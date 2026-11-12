import type { Metadata } from "next";
import { ProviderMarketRoute } from "@/components/provider-market/route-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Find your guild · Provider market", robots: { index: false, follow: false } };
export default async function MarketPage({ searchParams }: { searchParams: Promise<{ commission?: string | string[] }> }) {
  const { commission } = await searchParams;
  return <ProviderMarketRoute mode="buyer" commissionId={typeof commission === "string" ? commission : undefined}/>;
}
