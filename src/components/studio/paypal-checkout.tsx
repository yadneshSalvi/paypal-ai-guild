"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import type { Commission } from "@/contracts/guild";

type CheckoutResult = { commission: Commission; checkoutToken?: string };
type Buttons = { render: (element: HTMLElement) => Promise<void>; close: () => Promise<void>; isEligible: () => boolean };
type PayPalSdk = { Buttons: (options: { style: Record<string, string | number | boolean>; fundingSource?: string; createOrder: () => Promise<string>; onApprove: (data: { orderID: string }) => Promise<void>; onCancel: () => Promise<void>; onError: () => void }) => Buttons; FUNDING?: { PAYPAL: string } };
const loading = new Map<string, Promise<PayPalSdk>>();

function loadPayPal(clientId: string, intent: "authorize" | "capture"): Promise<PayPalSdk> {
  const namespace = intent === "authorize" ? "guildPayPalAuthorize" : "guildPayPalCapture";
  const key = `${clientId}:${intent}`;
  const present = (window as unknown as Record<string, PayPalSdk | undefined>)[namespace];
  if (present) return Promise.resolve(present);
  const prior = loading.get(key); if (prior) return prior;
  const promise = new Promise<PayPalSdk>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?${new URLSearchParams({ "client-id": clientId, currency: "USD", intent, components: "buttons", commit: intent === "capture" ? "true" : "false" })}`;
    script.dataset.namespace = namespace; script.async = true;
    script.onload = () => { const sdk = (window as unknown as Record<string, PayPalSdk | undefined>)[namespace]; if (sdk) resolve(sdk); else reject(new Error("PayPal's checkout did not finish loading.")); };
    script.onerror = () => { loading.delete(key); script.remove(); reject(new Error("PayPal's checkout could not load. You can use the secure redirect below.")); };
    document.head.append(script);
  });
  loading.set(key, promise); return promise;
}

export function PayPalCheckout({ intent, prepare, complete, onDismiss, onError }: { intent: "authorize" | "capture"; prepare: () => Promise<CheckoutResult>; complete: (input: { intentId: string; orderId: string; checkoutToken: string }) => Promise<unknown>; onDismiss: () => void; onError: (message: string) => void }) {
  const container = useRef<HTMLDivElement>(null), callbacks = useRef({ prepare, complete, onDismiss, onError });
  const flow = useRef<{ intentId: string; checkoutToken: string } | null>(null);
  const redirectInProgress = useRef(false);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading"), [redirecting, setRedirecting] = useState(false);
  callbacks.current = { prepare, complete, onDismiss, onError };
  useEffect(() => {
    let disposed = false, buttons: Buttons | undefined;
    const run = async () => {
      const response = await fetch("/api/payments/config", { cache: "no-store" });
      const config = await response.json() as { clientId?: string; message?: string };
      if (!response.ok || !config.clientId) throw new Error(config.message ?? "PayPal checkout is unavailable.");
      const paypal = await loadPayPal(config.clientId, intent);
      if (disposed || !container.current) return;
      buttons = paypal.Buttons({ fundingSource: paypal.FUNDING?.PAYPAL, style: { layout: "vertical", color: "gold", shape: "rect", label: "paypal", height: 48, tagline: false },
        createOrder: async () => {
          const result = await callbacks.current.prepare(), checkout = result.commission.payments.checkout;
          if (!checkout?.orderId || !result.checkoutToken || checkout.state !== "awaiting_payer") throw new Error("This checkout needs reconciliation before payer approval.");
          flow.current = { intentId: checkout.id, checkoutToken: result.checkoutToken }; return checkout.orderId;
        },
        onApprove: async ({ orderID }) => { if (disposed || redirectInProgress.current) return; if (!flow.current) throw new Error("Return to this commission to finish the original checkout."); await callbacks.current.complete({ ...flow.current, orderId: orderID }); },
        // A popup closing is a presentation event. Only an explicit cancellation return cancels durable authority.
        onCancel: async () => { if (!disposed && !redirectInProgress.current) callbacks.current.onDismiss(); },
        onError: () => callbacks.current.onError("PayPal could not finish this checkout. Your saved operation keeps its identity; check its status before trying again.") });
      if (!buttons.isEligible()) throw new Error("Use the secure redirect to finish PayPal approval.");
      await buttons.render(container.current); if (!disposed) setState("ready");
    };
    run().catch(error => { if (!disposed) { setState("unavailable"); callbacks.current.onError(error instanceof Error ? error.message : "Checkout is unavailable."); } });
    return () => { disposed = true; void buttons?.close().catch(() => undefined); };
  }, [intent]);
  const redirect = async () => { redirectInProgress.current = true; setRedirecting(true); try { const result = await prepare(), checkout = result.commission.payments.checkout; if (!checkout?.approvalUrl || checkout.state !== "awaiting_payer") throw new Error("The original checkout needs reconciliation before it can open."); window.location.assign(checkout.approvalUrl); } catch (error) { redirectInProgress.current = false; onError(error instanceof Error ? error.message : "Checkout could not open."); setRedirecting(false); } };
  return <div className="paypal-checkout">
    {state === "loading" && <p className="checkout-loading" role="status"><LoaderCircle size={17} className="spin"/> Loading PayPal’s secure checkout…</p>}
    <div ref={container} className="paypal-official-buttons" aria-label="Official PayPal sandbox checkout"/>
    <button type="button" className="text-button" disabled={redirecting} onClick={redirect}>{redirecting ? <LoaderCircle size={14} className="spin"/> : <ArrowUpRight size={14}/>} {state === "unavailable" ? "Continue securely on PayPal" : "Prefer to continue in this tab?"}</button>
    <p className="checkout-smallprint">PayPal Sandbox · Your PayPal credentials stay with PayPal.</p>
  </div>;
}
