import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runNextJob } from "@/server/jobs";
import { recoverPaymentWork } from "@/server/payments/service";
import { recoverWebhookObservations } from "@/server/payments/webhooks";
import { recoverNextOriginalHostedWebAudit } from "@/server/web/hosted-recovery";
import { recoverSavedWork } from "@/server/recovery";
export const runtime = "nodejs";
export const maxDuration = 800;
export async function GET(request: Request) {
  const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`), actual = Buffer.from(request.headers.get("authorization") ?? "");
  if (!process.env.CRON_SECRET || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return NextResponse.json({ ok: false }, { status: 401 });
  // Recover previously dispatched browser output before current job validation;
  // expired or revoked business authority cannot erase original observations.
  const result = await recoverSavedWork({ payment: recoverPaymentWork, webhooks: recoverWebhookObservations, hostedOriginal: recoverNextOriginalHostedWebAudit, production: runNextJob });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
