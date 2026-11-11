import { after, NextResponse } from "next/server";
import { DomainError } from "@/domain/primitives";
import { errorResponse } from "@/server/http";
import { paymentError } from "@/server/payments/service";
import { ingestPaymentWebhook, recoverWebhookObservations } from "@/server/payments/webhooks";
import { anonymousBucket, rateLimit } from "@/server/session";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    await rateLimit(`paypal-webhooks:${anonymousBucket(request)}`, 600);
    const reader = request.body?.getReader(); if (!reader) throw new DomainError("BODY_REQUIRED", "A signed event body is required.", 400, false);
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); throw new DomainError("BODY_TOO_LARGE", "The event exceeds the receiver limit.", 413, false); } chunks.push(part.value); }
    const result = await ingestPaymentWebhook(Buffer.concat(chunks).toString("utf8"), request.headers);
    after(async () => { await recoverWebhookObservations(); });
    return NextResponse.json({ accepted: true, duplicate: result.duplicate }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(paymentError(error)); }
}
