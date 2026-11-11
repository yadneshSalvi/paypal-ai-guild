"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, CircleAlert, Clock3, LoaderCircle } from "lucide-react";
import { money } from "./ui";

export function PaymentReturn({ commissionId, intentId, orderId, checkoutToken, cancel, amountMinor, route }: { commissionId: string; intentId: string; orderId: string; checkoutToken: string; cancel: boolean; amountMinor: number; route: "authorization" | "package_checkout" }) {
  const started = useRef(false), [message, setMessage] = useState(cancel ? "Closing this checkout…" : "Checking the original PayPal order…");
  const [status, setStatus] = useState<"loading" | "confirmed" | "pending" | "cancelled" | "error">("loading"), [errorCode, setErrorCode] = useState<string | null>(null);
  const submit = async (type: "complete_checkout" | "cancel_checkout" | "resume_checkout") => {
    setStatus("loading"); setErrorCode(null);
    try {
      const response = await fetch(`/api/commissions/${commissionId}/payments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, intentId, checkoutToken, ...(type === "cancel_checkout" ? {} : { orderId }) }) });
      const body = await response.json();
      if (!response.ok) { setErrorCode(body.code ?? "UNAVAILABLE"); throw new Error(body.message ?? "Return to settlement to inspect the saved payment."); }
      if (type === "cancel_checkout") { setStatus("cancelled"); setMessage("Checkout is cancelled. Your accepted work remains in the commission."); }
      else if (body.commission?.payments.checkout?.state === "approved") { setStatus("confirmed"); setMessage("PayPal confirmed the original checkout. Its receipt is saved with your commission."); }
      else { setStatus("pending"); setMessage("The payment is saved and still being reconciled. Settlement shows its latest confirmed state."); }
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "Return to settlement to inspect the saved payment."); }
  };
  useEffect(() => { if (started.current) return; started.current = true; void submit(cancel ? "cancel_checkout" : "complete_checkout"); }, [commissionId, intentId, orderId, checkoutToken, cancel]); // Initial return only; resume always requires a separate button press.
  return <main className="recovery-page payment-return"><Link className="wordmark" href="/">Guild<span>®</span></Link><p className="eyebrow">BACK TO THE WORK</p><h1>{status === "error" ? "One step needs your attention." : cancel ? "Your commission is safe." : "A receipt for every step."}</h1><p role={status === "error" ? "alert" : "status"} className={status === "error" ? "form-error" : undefined}>{status === "loading" ? <LoaderCircle className="spin" size={18}/> : status === "confirmed" ? <Check size={18}/> : status === "pending" ? <Clock3 size={18}/> : <CircleAlert size={18}/>} {message}</p>
    {errorCode === "CHECKOUT_CANCELLED" && !cancel && <section className="payment-resume"><h2>Keep the original order.</h2><p>Resume this {money(amountMinor)} {route === "authorization" ? "buyer authorization" : "accepted-work payment"} only if you intend to continue. Guild will recheck PayPal approval, the current Passport and the available spending ceiling. The earlier cancellation stays in the record.</p><button className="button primary" onClick={() => void submit("resume_checkout")}>Resume {money(amountMinor)} {route === "authorization" ? "authorization" : "payment"} <ArrowRight size={16}/></button></section>}
    <Link className="button" href={`/?view=settlement&commission=${commissionId}`}>Return to settlement <ArrowRight size={16}/></Link>
  </main>;
}
