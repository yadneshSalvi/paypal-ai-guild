import type { Metadata } from "next";
import { AgentConnections } from "@/components/provider-access/connections";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Workshop agent connections · Guild", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function ProviderConnectionsPage({ searchParams }: { searchParams: Promise<{ commission?: string | string[] }> }) {
  const { commission } = await searchParams;
  const context = typeof commission === "string" && /^[a-f0-9-]{36}$/i.test(commission) ? commission : undefined;
  return <AgentConnections scope="provider" commissionId={context}/>;
}
