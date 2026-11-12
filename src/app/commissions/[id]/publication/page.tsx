import { z } from "zod";
import { WebPublication } from "@/components/studio/web-publication";
import { currentSession } from "@/server/session";
import { publicationWorkspace } from "@/server/web/publications";
import { DomainError } from "@/domain/primitives";
export const dynamic = "force-dynamic";
export const metadata = { title: "The publication room · Guild" };
export default async function PublicationPage({ params }: { params: Promise<{ id: string }> }) {
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) return <WebPublication initial={null} commissionId="" initialError="That commission link is unavailable."/>;
  try {
    const session = await currentSession();
    if (!session) return <WebPublication initial={null} commissionId={id.data} initialError="Open this commission in an active owner or judge workspace to see its publication history."/>;
    return <WebPublication initial={await publicationWorkspace(session, id.data)} commissionId={id.data}/>;
  } catch (error) {
    return <WebPublication initial={null} commissionId={id.data} initialError={error instanceof DomainError ? error.message : "The publication record could not be read. Your original work remains saved."}/>;
  }
}
