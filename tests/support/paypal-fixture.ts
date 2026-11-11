import { randomUUID } from "node:crypto";
type Json = Record<string, any>;
/** Fixture responses through the real generated SDK. This class never contacts PayPal. */
export class PayPalWireFixture {
  readonly calls: { path: string; method: string; body: Json | null; requestId: string | null }[] = [];
  readonly orders = new Map<string, Json>(); readonly authorizations = new Map<string, Json>(); readonly captures = new Map<string, Json>();
  failNextCapture: "lost" | "pending" | "refused" | null = null;
  failNextCreate = false;
  beforeCapture: (() => Promise<void>) | null = null;
  beforeRead: (() => Promise<void>) | null = null;
  private id() { return randomUUID().replaceAll("-", "").slice(0, 17).toUpperCase(); }
  private response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Paypal-Debug-Id": "fixture-debug" } }); }
  orderJson(order: Json) { return { id: order.id, status: order.status, intent: order.intent, purchase_units: [{ amount: order.amount, custom_id: order.customId, payments: { authorizations: [...this.authorizations.values()].filter(a => a.orderId === order.id).map(a => ({ id: a.id, status: a.status, amount: a.amount })), captures: [...this.captures.values()].filter(c => c.orderId === order.id).map(c => ({ id: c.id, status: c.status, amount: c.amount })) } }], links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`, method: "GET" }] }; }
  approve(orderId: string) { this.orders.get(orderId)!.status = "APPROVED"; }
  fetch: typeof fetch = async input => {
    const request = input as Request, path = new URL(request.url).pathname, method = request.method;
    if (path === "/v1/oauth2/token") return this.response({ access_token: "fixture-token", token_type: "Bearer", expires_in: 3600 });
    const body = method === "POST" && request.headers.get("content-type")?.includes("json") ? await request.clone().json() as Json : null;
    this.calls.push({ path, method, body, requestId: request.headers.get("PayPal-Request-Id") });
    if (method === "GET" && this.beforeRead) { const callback = this.beforeRead; this.beforeRead = null; await callback(); }
    if (method === "POST" && path === "/v2/checkout/orders") {
      const id = this.id(), unit = body!.purchase_units[0];
      const order = { id, amount: unit.amount, intent: body!.intent, status: "CREATED", customId: unit.custom_id };
      this.orders.set(id, order);
      if (this.failNextCreate) { this.failNextCreate = false; throw new TypeError("Fixture lost create response"); }
      return this.response(this.orderJson(order), 201);
    }
    const orderMatch = path.match(/^\/v2\/checkout\/orders\/([^/]+)(?:\/(authorize|capture))?$/);
    if (orderMatch) {
      const order = this.orders.get(orderMatch[1]!); if (!order) return this.response({ name: "RESOURCE_NOT_FOUND" }, 404);
      if (method === "GET") return this.response(this.orderJson(order));
      if (orderMatch[2] === "authorize") { const id = this.id(); this.authorizations.set(id, { id, orderId: order.id, amount: order.amount, status: "CREATED" }); }
      if (orderMatch[2] === "capture") { const id = this.id(); this.captures.set(id, { id, orderId: order.id, amount: order.amount, status: "COMPLETED" }); }
      order.status = "COMPLETED"; return this.response(this.orderJson(order), 201);
    }
    const authorizationMatch = path.match(/^\/v2\/payments\/authorizations\/([^/]+)(?:\/(capture|void))?$/);
    if (authorizationMatch) {
      const auth = this.authorizations.get(authorizationMatch[1]!); if (!auth) return this.response({ name: "RESOURCE_NOT_FOUND" }, 404);
      if (method === "GET") return this.response({ id: auth.id, status: auth.status, amount: auth.amount });
      if (authorizationMatch[2] === "void") { auth.status = "VOIDED"; return new Response(null, { status: 204 }); }
      if (authorizationMatch[2] === "capture") {
        if (this.beforeCapture) { const callback = this.beforeCapture; this.beforeCapture = null; await callback(); }
        const failure = this.failNextCapture; this.failNextCapture = null;
        if (failure === "refused") return this.response({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYMENT_DENIED" }] }, 422);
        const id = this.id(), capture = { id, orderId: auth.orderId, amount: body!.amount, status: failure === "pending" ? "PENDING" : "COMPLETED" };
        this.captures.set(id, capture); auth.status = body!.final_capture ? "CAPTURED" : "PARTIALLY_CAPTURED";
        if (failure === "lost") throw new TypeError("Fixture lost capture response");
        return this.response({ id, status: capture.status, amount: capture.amount }, 201);
      }
    }
    const captureMatch = path.match(/^\/v2\/payments\/captures\/([^/]+)$/);
    if (captureMatch && method === "GET") { const capture = this.captures.get(captureMatch[1]!); if (capture) return this.response({ id: capture.id, status: capture.status, amount: capture.amount }); }
    throw new Error(`Fixture has no route: ${method} ${path}`);
  };
  writes(suffix: string) { return this.calls.filter(call => call.method === "POST" && call.path.endsWith(suffix)); }
}
