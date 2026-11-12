import type { Metadata } from "next";
import { ApprovalLink } from "@/components/provider-market/approval-link";
import { DomainError } from "@/domain/primitives";
import { requireSession } from "@/server/session";
import { previewApprovalLink } from "@/server/provider-market/approval-links";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { title: "Continue to your Passport · Guild", referrer: "no-referrer", robots: { index: false, follow: false } };
export default async function ApprovalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ challenge?: string | string[] }> }) {
  try {
    const session = await requireSession(), { id } = await params, { challenge } = await searchParams;
    const preview = await previewApprovalLink(session, id, challenge);
    return <ApprovalLink preview={preview} challenge={typeof challenge === "string" ? challenge : null} error={null}/>;
  } catch (error) {
    return <ApprovalLink preview={null} challenge={null} error={error instanceof DomainError ? error.message : "This link is incomplete or unavailable. Open it in the original owner's Guild workspace."}/>;
  }
}
