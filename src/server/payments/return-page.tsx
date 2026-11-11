import Link from "next/link";
import { z } from "zod";
import { PaymentReturn } from "@/components/studio/payment-return";
import { currentSession } from "@/server/session";
import { getPool } from "@/server/db";
import { digest } from "@/domain/primitives";
import { safeEqual } from "./repository";
export async function paymentReturnPage(searchParams: Promise<Record<string, string | string[] | undefined>>, cancel: boolean) {
  const query = await searchParams, session = await currentSession();
  const parsed = z.object({ commission: z.string().uuid(), challengeId: z.string().uuid(), challenge: z.string().min(32).max(128), token: z.string().regex(/^[A-Z0-9]{10,32}$/).optional() }).safeParse(query);
  const challenge = session && parsed.success ? (await getPool().query<{ payment_intent_id: string; token_hash: string; amount_minor: number; route: string }>("SELECT c.payment_intent_id,c.token_hash,(i.command->'action'->'money'->>'minor')::integer AS amount_minor,i.binding->>'route' AS route FROM guild_checkout_challenges c JOIN guild_payment_intents i ON i.id=c.payment_intent_id WHERE c.id=$1 AND c.commission_id=$2 AND c.tenant_id=$3 AND c.actor_id=$4", [parsed.data.challengeId, parsed.data.commission, session.tenantId, session.id])).rows[0] : null;
  if (!session || !parsed.success || !challenge || !safeEqual(challenge.token_hash, digest(parsed.data.challenge)) || !cancel && !parsed.data.token) return <main className="recovery-page"><Link className="wordmark" href="/">Guild<span>®</span></Link><p className="eyebrow">CHECKOUT RETURN</p><h1>Return to your studio.</h1><p>This return could not be matched to an active private workspace. Open the original commission to inspect its saved payment.</p><Link className="button primary" href="/?view=settlement">Open settlement</Link></main>;
  return <PaymentReturn commissionId={parsed.data.commission} intentId={challenge.payment_intent_id} checkoutToken={parsed.data.challenge} orderId={parsed.data.token ?? ""} cancel={cancel} amountMinor={challenge.amount_minor} route={challenge.route === "authorization" ? "authorization" : "package_checkout"}/>;
}
