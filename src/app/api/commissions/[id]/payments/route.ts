import { after, NextResponse } from "next/server";
import { z } from "zod";
import { paymentCommandSchema } from "@/contracts/payments";
import { errorResponse, readJson } from "@/server/http";
import { executePayment, recoverPaymentWork } from "@/server/payments/service";
import { rateLimit, requireSameOrigin, requireSession } from "@/server/session";
export const maxDuration = 300;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const session = await requireSession(), id = z.string().uuid().parse((await params).id);
    const command = paymentCommandSchema.parse(await readJson(request, 4096));
    await rateLimit(`payments:${session.tenantId}`, 120);
    if (command.type === "inspect_order") await rateLimit(`payment-reads:${session.tenantId}`, 20);
    const result = await executePayment(session, id, command);
    if (result.commission.payments.operations.some(o => ["queued", "claimed", "dispatching", "pending_reconciliation"].includes(o.state)) || result.commission.payments.payouts.some(p => ["claimed", "dispatching", "pending_reconciliation"].includes(p.operationState) || ["dispatching", "pending_reconciliation"].includes(p.cancellationState ?? ""))) after(async () => { await recoverPaymentWork(); });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
