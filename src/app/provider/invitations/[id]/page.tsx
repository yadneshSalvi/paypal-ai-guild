import type { Metadata } from "next";
import { ProviderInvitationAccess } from "@/components/provider-access/invitation";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your provider invitation · Guild", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function ProviderInvitationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProviderInvitationAccess invitationId={id}/>;
}
