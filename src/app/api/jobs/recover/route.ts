import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runNextJob } from "@/server/jobs";
import { recoverPaymentWork } from "@/server/payments/service";
import { recoverWebhookObservations } from "@/server/payments/webhooks";
export const maxDuration = 300;
export async function GET(request: Request) {
  const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`), actual = Buffer.from(request.headers.get("authorization") ?? "");
  if (!process.env.CRON_SECRET || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return NextResponse.json({ ok: false }, { status: 401 });
  const outcomes = await Promise.allSettled([runNextJob(), recoverPaymentWork(), recoverWebhookObservations()]);
  const value = (index: number) => { const result = outcomes[index]!; return result.status === "fulfilled" ? result.value : { state: "recoverable" }; };
  return NextResponse.json({ ok: true, production: value(0), payments: value(1), webhooks: value(2) }, { headers: { "Cache-Control": "no-store" } });
}
