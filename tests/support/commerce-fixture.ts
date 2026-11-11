import { randomUUID } from "node:crypto";
type Json = Record<string, any>;
/** Fixture-only wire responses through the canonical typed REST gateway; never calls PayPal. */
export class CommerceWireFixture {
  readonly calls: { path: string; method: string; body: Json | null; requestId: string | null }[] = [];
  readonly batches = new Map<string, Json>();
  readonly items = new Map<string, Json>();
  nextStatus = "SUCCESS";
  loseNextCreate = false;
  refuseNextCreate = false;
  failItemReads = false;
  loseNextCancel = false;
  mismatchedItemReceiver = false;
  beforeWrite: (() => Promise<void>) | null = null;
  private id() { return randomUUID().replaceAll("-", "").slice(0, 17).toUpperCase(); }
  private response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "paypal-debug-id": "fixture-commerce" } }); }
  private batchBody(batch: Json, includeItems = true) { return { batch_header: { payout_batch_id: batch.id, batch_status: "SUCCESS", sender_batch_header: { sender_batch_id: batch.senderBatchId }, amount: batch.amount, fees: { currency: "USD", value: "0.25" } }, ...(includeItems ? { items: batch.itemIds.map((id: string) => this.items.get(id)), total_items: batch.itemIds.length, total_pages: 1 } : {}) }; }
  fetch: typeof fetch = async input => {
    const request = input as Request, path = new URL(request.url).pathname, method = request.method;
    if (path === "/v1/oauth2/token") return this.response({ access_token: "fixture-commerce-token", token_type: "Bearer", expires_in: 3600 });
    const body = method === "POST" && request.headers.get("content-type")?.includes("json") ? await request.clone().json() as Json : null;
    this.calls.push({ path, method, body, requestId: request.headers.get("PayPal-Request-Id") });
    if (method === "POST" && this.beforeWrite) { const callback = this.beforeWrite; this.beforeWrite = null; await callback(); }
    if (method === "POST" && path === "/v1/payments/payouts") {
      if (this.refuseNextCreate) { this.refuseNextCreate = false; return this.response({ name: "INSUFFICIENT_FUNDS" }, 422); }
      const prior = [...this.batches.values()].find(b => b.senderBatchId === body!.sender_batch_header.sender_batch_id);
      if (prior) return this.response({ name: "DUPLICATE_BATCH_ID", links: [{ rel: "duplicate_batch", href: `https://api-m.sandbox.paypal.com/v1/payments/payouts/${prior.id}` }] }, 422);
      const id = this.id(), itemIds = body!.items.map((item: Json) => {
        const itemId = this.id();
        this.items.set(itemId, { payout_item_id: itemId, payout_batch_id: id, transaction_status: this.nextStatus, transaction_id: this.id(), payout_item: item, payout_item_fee: { currency: "USD", value: "0.25" }, time_processed: new Date().toISOString() }); return itemId;
      });
      const batch = { id, senderBatchId: body!.sender_batch_header.sender_batch_id, amount: body!.items[0].amount, itemIds }; this.batches.set(id, batch);
      if (this.loseNextCreate) { this.loseNextCreate = false; throw new TypeError("Fixture lost create response"); }
      return this.response(this.batchBody(batch, false), 201);
    }
    const batchMatch = path.match(/^\/v1\/payments\/payouts\/([^/]+)$/);
    if (method === "GET" && batchMatch) { const batch = this.batches.get(batchMatch[1]!); return batch ? this.response(this.batchBody(batch)) : this.response({ name: "RESOURCE_NOT_FOUND" }, 404); }
    const itemMatch = path.match(/^\/v1\/payments\/payouts-item\/([^/]+)(?:\/(cancel))?$/);
    if (itemMatch) {
      const item = this.items.get(itemMatch[1]!); if (!item) return this.response({ name: "RESOURCE_NOT_FOUND" }, 404);
      if (method === "GET") {
        if (this.failItemReads) return this.response({ name: "SERVICE_UNAVAILABLE" }, 503);
        if (this.mismatchedItemReceiver) return this.response({ ...item, payout_item: { ...item.payout_item, receiver: "wrong-fixture-recipient@example.invalid" } });
        return this.response(item);
      }
      if (method === "POST" && itemMatch[2] === "cancel") {
        if (item.transaction_status !== "UNCLAIMED") return this.response({ name: "ITEM_NOT_UNCLAIMED" }, 422);
        item.transaction_status = "RETURNED";
        if (this.loseNextCancel) { this.loseNextCancel = false; throw new TypeError("Fixture lost cancellation response"); }
        return this.response(item);
      }
    }
    throw new Error(`Fixture has no commerce route: ${method} ${path}`);
  };
  writes(suffix: string) { return this.calls.filter(call => call.method === "POST" && call.path.endsWith(suffix)); }
}
