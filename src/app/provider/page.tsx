import type { Metadata } from "next";
import { ProviderMarketRoute } from "@/components/provider-market/route-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your workshop · Provider console", robots: { index: false, follow: false } };
export default function ProviderPage() { return <ProviderMarketRoute mode="provider"/>; }
