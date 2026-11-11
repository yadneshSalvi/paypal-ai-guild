# Guild payment integration contract

## Immutable core 0.2.6 adoption

The current package is `vendor/fracture-paypal-core-0.2.6.tgz`, SHA-256 `099c2097279f90a706abdabb548e08874ef47d3abb4e91d52b3376df7f93cad9`. The packaged README was read and archive hash verified before changing dependency/lock. It preserves the 0.2.4 financial/private-storage contracts and adds normalized invoice/payout webhook observations with conflicting-ID quarantine; 0.2.6 corrects the runtime evidence version. Its 136 fixture checks do not establish authentic webhook delivery or Guild settlement qualification. Root-owned core source remains untouched. Guild intake must verify the registered webhook, preserve deduplication and reread an owned exact resource before changing any money state. No event payload alone authorizes an action.

## Checkout return recovery (implemented 2026-11-11)

The official JS button's `onCancel` is treated as a popup dismissal, without mutating the durable checkout. A PayPal cancellation return or explicit cancellation command still cancels the local instruction. Same-tab redirect keeps the original order.

An explicit `resume_checkout` action can resume only the latest original, unexpired, cancelled checkout after the same curator presents its challenge, a fresh owned-order SDK read reports `APPROVED` without authorization/capture resources, the original signed Passport remains current, and the workspace ceiling is re-reserved under the tenant lock. Resume creates the original `complete:<intent>` decision once and uses the existing SDK authorization/capture boundary; it cannot create a replacement order or extend the challenge expiry. Cancellation time is retained alongside resumed actor/time and an immutable resume event. Concurrent repeats return the same operation. Errors and cancellations use an attention icon rather than a success checkmark. Four PostgreSQL/actual-SDK-fixture regression scenarios cover identity/history, rejection gates, revocation during preflight, and workspace/supersession bounds.


Frozen 11 November 2026. Owner: Guild integration lead. Scope authorization: the approved complete Guild plan and controlled sandbox operations. This is an implementation contract, not a claim of provider success.

## Commercial execution revision · 11 November 2026

Baseline before this revision: strict TypeScript passes; 11 domain and 7 PostgreSQL tests pass. Existing exemplars are `src/server/commissions.ts` for locked command admission and append-only evidence, `src/server/session.ts` for authenticated tenant access, and `tests/integration/workspace.test.ts` for PostgreSQL invariants. This revision consumes the immutable core's public API; it does not change the SDK or the canonical shared package. The current target is v0.2.6 as specified above; do not patch an archive or import sibling source.

### Typed REST transport contract introduced in 0.2.4

The historical introduction archive was `vendor/fracture-paypal-core-0.2.4.tgz`, SHA-256 `5c03e848a603c91f98f213c9bfee2e5e4ccb00fd54946ae349945c55f53c3f0f`. Its packaged README, types and `commerce-rest.ts` were read before upgrading. The Orders/Payments SDK contract is unchanged; Payouts uses explicitly typed REST because the pinned SDK has no Payouts controller. Root's 131 fixture conformance cases and one controlled $1 payout do not qualify Guild awards.

Guild owns `src/server/payments/payouts.ts` and migration 004. Each award binds an immutable accepted contract, successful capture, current signed approval, controlled recipient hash, exact USD amount, stable sender batch/item IDs and request ID. The domain commits its unique claim and reservation before dispatch and rechecks current authority. Recipient-bearing request/result documents use authenticated encryption with tenant, commission and operation in independent associated data. Public snapshots contain masked resource labels and provider IDs only. Batch acknowledgement never becomes provider-paid; exact owned item `SUCCESS` does. Unknown dispatches keep reservations. Recovery reads the known original batch; explicit unknown-create recovery may resend only the identical saved batch within the provider's duplicate window, never a new identity. Cancellation requires a current exact `UNCLAIMED` item and observed `RETURNED`.

Consume `SandboxCommerceRestGateway`, `CreatePayout`, `PayoutBatchObservation`, `PayoutItemObservation` and `CommerceRestResult` from the package root. Recipients use `EMAIL` because Guild's controlled sandbox registry has email destinations. Provider public IDs map to server-side controlled recipients; request input cannot supply a destination. Methods used are `createPayout(input,signal?)`, `getPayoutBatch(batchId,senderBatchId,signal?)`, `getPayoutItem(itemId,signal?)`, and `cancelUnclaimedPayout(owned,signal?)`. Preserve `outcome`, safe code, observation timestamp and exact matched result; no automatic retry.

The application extension owns `src/server/payments/`, `src/domain/payments.ts`, migration 003, payment API routes and the settlement UI. A persisted Guild payment binding precedes the core claim and binds the exact approval receipt, commission, accepted award, contract version, artifact and criterion digests. `GuildPaymentPolicy.authorize` re-reads current durable authority before claim and immediately before dispatch. The supported core calls and SDK appendix below remain unchanged.

The root Passport approval is a server-signed application receipt, never payer consent. A PayPal AUTHORIZE order binds the current cap and an explicit buyer callback challenge. Package checkout/capture requires a live artifact plus a curator acceptance record; sample, replay, and system-qualification records remain nonpayable. Amount, payee, source identity, service allocation and final-capture selection are server-derived. The legal resource set comes only from this commission's stored successful/pending operations; a provider-wide existence check never establishes ownership.

| Application write | Durable identity before provider dispatch | Admission and final check | Recovery evidence / test |
|---|---|---|---|
| Authorization order | `guild_payment_intents`, one semantic order per commission/approved plan; tenant aggregate ceiling locked on `guild_tenants` | `prepareCheckout`, `GuildPaymentPolicy.authorize`; current signed plan, live workspace, active root and USD cap | Known order is re-read; unknown create ID stays unknown. `payments.test.ts` / PostgreSQL `payments.test.ts` lost-create and duplicate cases |
| Authorize approved order | Same intent table, stable order-bound key and core request ID | `completeCheckout`; challenge, owner, exact stored order, current plan; core reads APPROVED order and exact cap | Core authoritative order/authorization reads; repeat callback returns the original operation |
| Accepted package capture | Unique commission/package/contract acceptance identity, plus core authorization reservation | Exact acceptance, live artifact, immutable fee allocation, active ancestor chain; fresh owning-order captures and authorization budget | Unknown partial capture remains reserved and is never inferred from an older equal amount; concurrent package tests |
| Accepted package checkout | One order per exact acceptance; buyer callback has its own persisted challenge | Same payable gate plus supported official PayPal approval | Capture uses the same accepted amount and stored order; callback replay cannot create a second charge |
| Authorization void | Unique closure intent | Current owned authorization; no unfinished accepted payable work or pending/unknown capture; explicit close decision | Authoritative VOIDED read; refusal/unknown remains visible and does not imply release |

`finalCapture` is computed under the commission lock. It is true only for the last uncaptured accepted package when every other package is accepted and already captured, there is no correction/recourse/unknown operation, and the commission enters settling. Closure copy additionally requires a stored passed account-qualification record plus authoritative closed authorization retrieval. Before that, show the exact uncaptured amount and pending closure. Refunds, invoicing and saved-wallet consent remain separate follow-on actions; they are not silently enabled by this extension.

Plan digests now bind source hashes, objective, languages, opening instant/timezone, all commercial components, acceptance-pack digest, dependency/duration and actual mandate scope/expiry, not a client-supplied digest alone. An older approval does not gain new authority; it needs the current plan approved again. Domain errors have a typed code and a useful recovery action.

### Official PayPal browser and Toolkit contracts

Official JavaScript SDK v5 authorization guide read 11 November 2026: `https://developer.paypal.com/v5/checkout/auth-capture`. Load the unmodified official SDK with the public app client ID, USD and `intent=authorize`; `Buttons.createOrder` calls our durable server order command; `onApprove` passes the returned order ID and the original stored challenge to our server, which independently retrieves approval. Package fallback uses `intent=capture`. No SDK secret, buyer password, or saved-wallet token is sent to the browser. A verified provider approval link is available as a redirect recovery path.

PayPal Agent Toolkit is pinned to `@paypal/agent-toolkit@1.11.0` (npm integrity `sha512-wfjOaF67uuBRtyc3wapD+0xbfMbo0Zje/HzmYsqOkonULh1aXs4b8N1UD+6Iy2AIQ/yPs7DtKU1Upc9F87KmOg==`). The published `openai/index.d.ts` and implementation were read before implementation. Import `PayPalAgentToolkit` from `@paypal/agent-toolkit/openai`; constructor takes `{clientId,clientSecret,configuration:{actions,context}}`; `getTools()` returns ChatCompletionTool[] and `handleToolCall({id,type:'function',function:{name,arguments}})` returns a tool message. The implemented read configuration is `{orders:{get:true}}`, with `context:{sandbox:true,debug:false}`. Only `get_order`, taking `{id}`, is exposed. `get_refund` is not enabled or qualified in Guild. `handleToolCall` itself does not enforce the configured action list: Guild validates an exact local allowlist and tenant-owned resource set first.

Toolkit uses Axios REST on `https://api.sandbox.paypal.com`, with OAuth client credentials acquired privately. Its own `@paypal/paypal-server-sdk` dependency is an internal implementation detail and does not replace Guild's selected APIMatic SDK. Guild imports the supported `axios/dist/node/axios.cjs` entry to share Toolkit's actual CJS client. An AsyncLocalStorage request boundary permits only OAuth POST and GET of the exact owned order on this sandbox origin, with 15-second timeout, zero redirects, 1 MB response and 8 KB request bounds. This avoids a confirmed Turbopack numeric-module rewrite of nested createRequire/resolve. Toolkit debug logging is rejected. Results are parsed and reduced to safe resource/amount/status fields before persistence or model feedback. Failure is a typed unavailable state; never return raw Toolkit errors or provider personal data.

The separate `create_refund` schema takes `capture_id`, optional `amount:{currency_code,value}`, `invoice_id`, and `note_to_payer`. Source shows `context.request_id` forwarded as `PayPal-Request-Id`, and the REST body includes `capture_id`. A wire test will record this exact behavior. Refund proposal UI, recourse allocation and Toolkit refund transport are not implemented by this revision. The future approved refund must execute through a guarded boundary only after domain admission and the selected transport equivalence, timeout, authority and reconciliation gates pass. Calling a tool with the same name is never shown as proof that Toolkit transport ran.

Actual Guild qualification now includes one $640 authorization followed by a fresh confirmed zero-capture void, and one model-selected official Toolkit get_order read of that original owned order. The model response ID and body hash are retained; no financial operation changed during the read. The order reports COMPLETED with zero capture records, which is not payment evidence. Safe proofs are in docs/evidence/payments/. Only zero_capture_void is qualified; no partial/final closure or provider award has been observed. Parent root handles the buyer browser and merchant corroboration; no additional user approval is required for the already authorized sandbox work.

## Repository and runtime

Greenfield Next.js App Router application at repository root, Node 22.22.3, npm lockfile, ESM TypeScript with strict checking. Existing exemplar: `AGENTS.md`; no application or baseline tests existed before this change. Planned checks: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:integration`. Public source must run without private plans or sibling paths.

Use the immutable `vendor/fracture-paypal-core-0.2.6.tgz`, package `@fracture/paypal-core@0.2.6`, SHA256 `099c2097279f90a706abdabb548e08874ef47d3abb4e91d52b3376df7f93cad9`. Its dependency remains APIMatic `paypal@2.29.0`, source commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`. Installed root resolution and shipped maps verified. No raw SDK calls or SDK source modifications are planned; use the package root.

The APIMatic and typed commerce REST boundaries use only `https://api-m.sandbox.paypal.com`; the independently constrained official Toolkit uses its native `https://api.sandbox.paypal.com` host. `SandboxPayPalProvider` rejects any other host and requires isolated configuration. `PAYPAL_ENVIRONMENT=sandbox` and `PAYPAL_PROJECT_ISOLATED=true` are checked at our boundary. Credentials are server-only; no payer credentials in model inputs or logs. Root has verified isolated OAuth. Resource reads require the actual owned IDs persisted by Guild; do not invent or probe arbitrary IDs to fabricate qualification. Each write must await its real payer/acceptance prerequisites. Transaction Search read qualification is separately recorded.

## Core interface and execution decisions

`PaymentCore({store,provider,policy})` exposes `execute(command)`, `retry(scope,id)`, `reconcile(scope,id)`, `recover(scope)`, `listReceipts(scope)`, and `ingestWebhook(scope,rawBody,headers,verifier)`. `SqlPaymentStore` over `PostgresDatabase` is authoritative. `initialize()` runs with schema migration. No in-memory financial store.

Every `PaymentCommand` binds scope `{tenantId,projectId}`, stable `operationId`, semantic `businessKey`, `intentId`, stable `providerRequestId`, `payloadHash(action)`, typed action, and approval `{id,version,digest,expiresAt}`. The approval is derived from current durable authenticated Guild records; browser amounts, provider text, and model suggestions do not supply it.

Core actions: `create_order` (money, intent CAPTURE or AUTHORIZE, customId), `authorize_order`/`capture_order` (money, orderId), `capture_authorization` (money, authorizationId, optional owning orderId and finalCapture), `refund_capture` (money, captureId, optional orderId), `void_authorization` (money, authorizationId, optional orderId). All money is integer minor units with USD. The project creates only its own commands; provider object IDs are loaded from tenant-owned operations.

The package retains one app-scoped SDK client, flat `serverOptions.baseUrl`, OAuth2 client credentials, no environment enum, retries disabled (`maxRetries:0`), 15-second attempt timeout and 25-second signal deadline. Logging is explicitly off. `fetch(Request)` preserves abort and credentials. All SDK calls use `.asApiResult()` directly on the returned ApiPromise. No per-call generic header bag exists. The SDK's generated Idempotency-Key is not business deduplication. No SDK pagination helper exists; scoped Transaction Search explicitly pages and reports incomplete results. No `Error` model import will shadow global Error.

## Financial fixture and domain ownership

| Package | Award cents | Service cents | Gross cents |
|---|---:|---:|---:|
| Research | 9000 | 800 | 9800 |
| Translation | 12000 | 1000 | 13000 |
| Narration | 8000 | 700 | 8700 |
| Image treatment | 4500 | 500 | 5000 |
| Accepted web design | 16000 | 1500 | 17500 |
| Captions/easy-read | 3500 | 500 | 4000 |
| Total | 53000 | 5000 | 58000 |

Root application cap is 64000 cents. Rejected Formwork 12000-cent award receives no capture. Primary authorization route requires real two-partial-capture and final-capture closure qualification; otherwise six separate approved package checkouts preserve acceptance-first billing. Never call application allocations held funds. The last accepted package may use `finalCapture:true` only after no open/correctable/recourse-pending package remains. Released remainder copy requires authoritative closure plus separate account gate evidence.

## DURABLE WRITES — DUPLICATE CLAIMS

| Write | Claim before dispatch | Duplicate rejection and handling | Guild binding / implementation |
|---|---|---|---|
| create_order | core payment operation, stable commission or package business key | SqlPaymentStore unique key/locked transaction; loser receives winner | Implemented: owned commission, current signed plan/merchant binding, locked workspace exposure and exact server-derived amount |
| authorize_order | core payment operation, order-bound business key | same SQL claim; loser receives winner | Implemented: original owned payer-approved order, bound challenge, original expiry and exact cap |
| capture_order | core payment operation, acceptance-bound key | same SQL claim; loser receives winner | Implemented: exact live curator acceptance, artifact/criteria/contract identity and gross |
| capture_authorization | core claim plus locked authorization reservation | same SQL claim and remaining-balance guard | Implemented: accepted package plus fresh owned order/authorization and conservative capture reservation |
| refund_capture | core claim plus locked capture refund reservation | same SQL claim and remaining-refundable guard | TBD: approved recourse allocation, captured resource |
| void_authorization | core payment operation, authorization closure key | same SQL claim; loser receives winner | Implemented: no unknown capture; explicit billing switch preserves unpaid accepted obligations |

Do not blindly release ambiguous claims. Core statuses are claimed/dispatching/succeeded/pending_reconciliation/refused/not_sent; explicit retry only for a safe retryable state with fresh domain authority. An ambiguous financial attempt always retains the same business/request identity. A deliberately cancelled uncharged checkout may admit a distinct explicit new checkout decision; this cannot replace an uncertain dispatched order or create an extra authorization.

## UNKNOWN OUTCOMES

| Write | Read / correlation | Unknown behavior | Guild test |
|---|---|---|---|
| create_order | Known order ID, if recovered from recorded receipt | Lost ID has no invented request-ID lookup; stays pending reconciliation and blocks duplicate | PostgreSQL real-SDK lost-create and fresh-runtime tests pass |
| authorize_order | getOrder(orderId), unique matching authorization, getAuthorizedPayment | exact amount/status/identity required | Concurrent callback, original challenge and same-order resume tests pass; actual authorization observed |
| capture_order | getOrder(orderId), unique matching capture, getCapturedPayment | exact amount/status/identity required | All six package fallback and repeated callback fixture tests pass |
| capture_authorization | authorization plus known capture ID | Unattributed partial capture stays unknown; never assign an older capture | Unknown partial, concurrent package and full six-capture fixtures pass |
| refund_capture | known refund, or owning-order refund with customId=operationId | exact correlated refund only; aggregate refunded amount is insufficient | TBD |
| void_authorization | getAuthorizedPayment(authorizationId) | VOIDED confirms; CANNOT_BE_VOIDED means reread, no fake release | Fixture fallback plus actual zero-capture void pass; partial void remains open |

Core reconciles in the write catch for connection, timeout, and unreadable success. Auth/encode are not_sent and do not trigger a provider-state reread. A durable worker calls recover after dispatch lease expiry. The missing-order-ID limitation is an explicit selected conservative behavior, already authorized in the common core, not an open SDK lookup.

## CROSS-OPERATION INVARIANTS

| Invariant | Legal set | Enforcement | Test |
|---|---|---|---|
| Tenant owns command and objects | Authenticated session plus all scope-owned operation mappings | Before claim and at final policy gate | Cross-tenant, callback-binding and changed-merchant regressions pass |
| Payment requires accepted work | Signed acceptance at current contract+artifact digest | Before create package checkout/capture | Sample/operator/artifact-substitution/meaning-review tests pass |
| No cap/scope broadening | Entire ancestor chain plus locked active reservations | Transactional domain policy | Ancestor reservation, tenant ceiling, concurrent requests and six-fallback tests pass |
| Quote, plan and authority fresh | Stored versions, expiry and revocation | Before approval/award/dispatch | Revocation during fresh capture/payout/resume reads prevents dispatch |
| Refund bounded and approved | Recourse decision plus fresh complete resource consumption | Before claim plus core reservation | TBD |
| Final capture closes only eligible commission | Package states and closure capability evidence | Before finalCapture dispatch | Unit rule and six-capture SDK fixture pass; live closure qualification remains open |
| Provider compensation once per accepted award | Accepted award and controlled receiver mapping | Payout extension gate | Concurrent award, exact item binding, unknown-create, cancellation and private-document tests pass; live six-award proof remains open |

## OPTIONAL FIELDS

For each create/authorize/capture/refund/void call, core sets `payPalRequestId` from the durable claim and `prefer:return=representation` to obtain receipt evidence. Leave mock-response/auth-assertion/client-metadata/partner-attribution headers absent. Their SDK defaults are captured in the operation appendix. No query defaults are overridden except explicit scoped Transaction Search paging.

| Operation body field | Requirement | Set? |
|---|---|---|
| OrderRequest.intent / purchaseUnits | approved billing route and exact amount | required |
| PurchaseUnitRequest.amount.currencyCode/value | exact approved USD minor amount rendered as decimal string | required |
| PurchaseUnitRequest.customId | correlation and owned business reference | yes |
| create_order.experience | approved return/cancel flow | v0.2.1 supports returnUrl, cancelUrl, userAction, shippingPreference, optional brand/locale/landing; current policy must grant checkoutOrigins |
| create_order.savedWallet | exact active standing consent, if selected | v0.2.1 supports consent id/version/digest plus vault, initiator/pattern/usage; current savedWalletConsent + expiresAt and vault grant required |
| All other optional purchase/order members | no selected requirement | omit |
| authorize/capture order optional body | live Sandbox requires Content-Type even for empty body | typed body:{} (v0.2.1 wire regression); omission produced actual415 |
| CaptureRequest.amount | accepted gross allocation | yes |
| CaptureRequest.finalCapture | commission closing rule | explicit false until qualified final capture |
| CaptureRequest.invoiceId/paymentInstruction/noteToPayer/softDescriptor | no requirement | omit |
| RefundRequest.amount/customId | approved partial remedy / operation correlation | yes |
| RefundRequest.invoiceId/noteToPayer/paymentInstruction | no requirement | omit |
| void body | no body in operation map | none |

Model facts: OrderRequest intent/purchaseUnits are required; PurchaseUnitRequest.amount is required and customId optional; Money.currencyCode/value are required strings. CaptureRequest and RefundRequest members are optional, not required-nullable. CaptureRequest.finalCapture defaults false on encoding. CheckoutPaymentIntent.Capture="CAPTURE", .Authorize="AUTHORIZE"; enum permits unknown strings, so our domain permits only those two. Omit missing optional fields; do not pass undefined under exactOptionalPropertyTypes. Response id/status and amount are validated by core even where SDK types are optional.

## WHEN THE API SAYS NO

Applies individually to createOrder, authorizeOrder, captureOrder, captureAuthorizedPayment, refundCapturedPayment, voidPayment and all resource reads: caller-caused 4xx preserves HTTP status; 401/403 becomes 502; 429 becomes 503; 5xx/read transport failure becomes 502; ambiguous writes remain pending reconciliation. Provider bodies must never expose personal data. Core v0.2.1 preserves allowlisted safe provider issue codes while returning sanitized fixed text. The initial missing-code behavior was resolved in v0.1.1. Do not fork the immutable archive. Guild's domain refusals already carry a precise rule and remedy.

## Assumptions and capability gates

No unverified payment behavior will be presented as completed. Core return/cancel experience and saved-wallet command bindings are released in v0.2.1. Guild financial policies, payout/cancellation execution, actual Toolkit get_order use and normalized webhook intake are implemented at this checkpoint. Invoice bookkeeping, recourse/refunds, Toolkit refund tooling, standing-wallet consent and complete live settlement remain follow-on units and require amended domain operation sheets before implementation. Current production audit findings remain explicitly open; see docs/evidence/payments/dependency-review.md. Root has observed live authorize/partial-capture/void/refund and Toolkit reads on Fracture; those are not Guild merchant qualification. Delayed-disbursement partner access is outside the selected hero and is not requested automatically. These gates preserve the complete scope; they do not block independent app/domain/exhibition work or require another user approval. Current user authorization already covers sandbox setup/build/deployment. Production-money access is not in scope.

## Verified commercial checkpoint

The current local checks are 19 domain/Toolkit tests, 38 PostgreSQL/real-SDK/typed-REST fixture tests, strict typechecking, production build and extended HTTP smoke. Test-created artifacts marked payable exist only inside isolated disposable schemas and carry explicit fixture provenance; they are not promoted into the running app. Financial fixture totals are $580 captured, $530 in six exact awards and $50 service allocation. Actual sandbox evidence remains one $640 authorization/zero-capture void and one read-only get_order, with captured=0 and providerPaid=0.

Webhook verification uses the registered PAYPAL_WEBHOOK_ID, the immutable core's normalized observation/deduplication, and a leased minimal queue. Only independently owned exact resource reads project state. Invalid, conflicting, early and unowned fixture cases pass without guessed reads or financial writes. Authentic signed delivery remains unqualified. Cancellation has an independent lease; interrupted cancellation recovery cannot resend until a fresh exact UNCLAIMED read and explicit decision.

The read agent saves a running attempt before module initialization, its model response reference before tool dispatch, then a completed safe result or durable safe failure. The public view polls existing state without redriving a model request. The qualified tool list is exactly get_order. APP_URL must be the canonical HTTPS hosted origin; missing hosted configuration fails closed.

## REQUIRED READING

- MUST load typescript-integrate-paypal — read before authored project files.
- MUST load typescript-getting-started — read; installed SDK and operation map resolution verified.
- MUST load typescript-error-handling — read; distinguish operational kinds and unknown writes.
- MUST load typescript-client-initialization — read; immutable core owns construction.
- MUST load typescript-testing — read; real SDK fetch seam for transport tests.

Any future raw SDK modification also loads authentication, calling-endpoints, models, and configuration-resilience before that work. The initial app consumes the existing package implementation rather than recreating it.

## Installed operation contracts

The following appendix is copied directly from the pinned installed maps and covers every SDK operation used by core in this phase. It fixes signatures, request fields/channels/defaults, response types, per-operation error arms, and model source paths. There are no open symbol lookups in this phase.

### createOrder

- **Signature**: `createOrder(request: Orders.CreateOrderRequest, options?: RequestOptions): ApiPromise<Order, Orders.CreateOrderError>`
- **Wire**: `POST /v2/checkout/orders`
- **Auth**: `oauth2`
- **Request body**: `application/json` — the `body` field
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `Order`
- **Error**: `PaypalError` with `kind: "api"`, an instance of `Orders.CreateOrderError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [401] `Error` · `"error3"` [422] `Error` · `"error4"` [default — any status no arm above covers] `Error` · `"undeclared"` [a `default`-matched body that did not fit `Error`] `rawBody: ArrayBuffer`

**Fields** — `Orders.CreateOrderRequest` (7):

| Field | Channel | Wire | Type | Req | Default |
| --- | --- | --- | --- | --- | --- |
| `payPalMockResponse` | `header` | `PayPal-Mock-Response` | `string` | no | — |
| `payPalRequestId` | `header` | `PayPal-Request-Id` | `string` | no | — |
| `payPalPartnerAttributionId` | `header` | `PayPal-Partner-Attribution-Id` | `string` | no | — |
| `payPalClientMetadataId` | `header` | `PayPal-Client-Metadata-Id` | `string` | no | — |
| `prefer` | `header` | `Prefer` | `string` | no | `"return=minimal"` |
| `payPalAuthAssertion` | `header` | `PayPal-Auth-Assertion` | `string` | no | — |
| `body` | `body` | — | `OrderRequest` | yes | — |

| Type | Schema value | Source |
| --- | --- | --- |
| `OrderRequest` | `orderRequestSchema` | `src/models/order-request.ts` |
| `Order` | `orderSchema` | `src/models/order.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |


### getOrder

- **Signature**: `getOrder(request: Orders.GetOrderRequest, options?: RequestOptions): ApiPromise<Order, Orders.GetOrderError>`
- **Wire**: `GET /v2/checkout/orders/{id}`
- **Auth**: `oauth2`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `Order`
- **Error**: `PaypalError` with `kind: "api"`, an instance of `Orders.GetOrderError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [401] `Error` · `"error2"` [404] `Error` · `"error3"` [default — any status no arm above covers] `Error` · `"undeclared"` [a `default`-matched body that did not fit `Error`] `rawBody: ArrayBuffer`

**Fields** — `Orders.GetOrderRequest` (4):

| Field | Channel | Wire | Type | Req |
| --- | --- | --- | --- | --- |
| `id` | `path` | — | `string` | yes |
| `fields` | `query` | — | `string` | no |
| `payPalMockResponse` | `header` | `PayPal-Mock-Response` | `string` | no |
| `payPalAuthAssertion` | `header` | `PayPal-Auth-Assertion` | `string` | no |

| Type | Schema value | Source |
| --- | --- | --- |
| `Order` | `orderSchema` | `src/models/order.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |


### authorizeOrder

- **Signature**: `authorizeOrder(request: Orders.AuthorizeOrderRequest, options?: RequestOptions): ApiPromise<OrderAuthorizeResponse, Orders.AuthorizeOrderError>`
- **Wire**: `POST /v2/checkout/orders/{id}/authorize`
- **Auth**: `oauth2`
- **Request body**: `application/json` — the `body` field. **Optional**: omit it and the request carries no body and no `Content-Type` header at all
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `OrderAuthorizeResponse`
- **Error**: `PaypalError` with `kind: "api"`, an instance of `Orders.AuthorizeOrderError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [401] `Error` · `"error3"` [403] `Error` · `"error4"` [404] `Error` · `"error5"` [422] `Error` · `"error6"` [500] `Error` · `"error7"` [default — any status no arm above covers] `Error` · `"undeclared"` [a `default`-matched body that did not fit `Error`] `rawBody: ArrayBuffer`

**Fields** — `Orders.AuthorizeOrderRequest` (7):

| Field | Channel | Wire | Type | Req | Default |
| --- | --- | --- | --- | --- | --- |
| `id` | `path` | — | `string` | yes | — |
| `payPalMockResponse` | `header` | `PayPal-Mock-Response` | `string` | no | — |
| `payPalRequestId` | `header` | `PayPal-Request-Id` | `string` | no | — |
| `prefer` | `header` | `Prefer` | `string` | no | `"return=minimal"` |
| `payPalClientMetadataId` | `header` | `PayPal-Client-Metadata-Id` | `string` | no | — |
| `payPalAuthAssertion` | `header` | `PayPal-Auth-Assertion` | `string` | no | — |
| `body` | `body` | — | `OrderAuthorizeRequest` | no | — |

| Type | Schema value | Source |
| --- | --- | --- |
| `OrderAuthorizeRequest` | `orderAuthorizeRequestSchema` | `src/models/order-authorize-request.ts` |
| `OrderAuthorizeResponse` | `orderAuthorizeResponseSchema` | `src/models/order-authorize-response.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |


### captureOrder

- **Signature**: `captureOrder(request: Orders.CaptureOrderRequest, options?: RequestOptions): ApiPromise<Order, Orders.CaptureOrderError>`
- **Wire**: `POST /v2/checkout/orders/{id}/capture`
- **Auth**: `oauth2`
- **Request body**: `application/json` — the `body` field. **Optional**: omit it and the request carries no body and no `Content-Type` header at all
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `Order`
- **Error**: `PaypalError` with `kind: "api"`, an instance of `Orders.CaptureOrderError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [401] `Error` · `"error3"` [403] `Error` · `"error4"` [404] `Error` · `"error5"` [422] `Error` · `"error6"` [500] `Error` · `"error7"` [default — any status no arm above covers] `Error` · `"undeclared"` [a `default`-matched body that did not fit `Error`] `rawBody: ArrayBuffer`

**Fields** — `Orders.CaptureOrderRequest` (7):

| Field | Channel | Wire | Type | Req | Default |
| --- | --- | --- | --- | --- | --- |
| `id` | `path` | — | `string` | yes | — |
| `payPalMockResponse` | `header` | `PayPal-Mock-Response` | `string` | no | — |
| `payPalRequestId` | `header` | `PayPal-Request-Id` | `string` | no | — |
| `prefer` | `header` | `Prefer` | `string` | no | `"return=minimal"` |
| `payPalClientMetadataId` | `header` | `PayPal-Client-Metadata-Id` | `string` | no | — |
| `payPalAuthAssertion` | `header` | `PayPal-Auth-Assertion` | `string` | no | — |
| `body` | `body` | — | `OrderCaptureRequest` | no | — |

| Type | Schema value | Source |
| --- | --- | --- |
| `OrderCaptureRequest` | `orderCaptureRequestSchema` | `src/models/order-capture-request.ts` |
| `Order` | `orderSchema` | `src/models/order.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |


### captureAuthorizedPayment

- **Signature**: `captureAuthorizedPayment(request: Payments.CaptureAuthorizedPaymentRequest, options?: RequestOptions): ApiPromise<CapturedPayment, Payments.CaptureAuthorizedPaymentError>`
- **Wire**: `POST /v2/payments/authorizations/{authorization_id}/capture`
- **Auth**: `oauth2`
- **Request body**: `application/json` — the `body` field. **Optional**: omit it and the request carries no body and no `Content-Type` header at all
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `CapturedPayment`
- **Error**: `PaypalError` with `kind: "api"`, an instance of `Payments.CaptureAuthorizedPaymentError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [401] `Error` · `"error3"` [403] `Error` · `"error4"` [404] `Error` · `"error5"` [409] `Error` · `"error6"` [422] `Error` · `"error500"` [500] no body · `"error7"` [default — any status no arm above covers] `Error` · `"undeclared"` [a `default`-matched body that did not fit `Error`] `rawBody: ArrayBuffer`

**Fields** — `Payments.CaptureAuthorizedPaymentRequest` (6):

| Field | Channel | Wire | Type | Req | Default |
| --- | --- | --- | --- | --- | --- |
| `authorizationId` | `path` | `authorization_id` | `string` | yes | — |
| `payPalMockResponse` | `header` | `PayPal-Mock-Response` | `string` | no | — |
| `payPalRequestId` | `header` | `PayPal-Request-Id` | `string` | no | — |
| `prefer` | `header` | `Prefer` | `string` | no | `"return=minimal"` |
| `payPalAuthAssertion` | `header` | `PayPal-Auth-Assertion` | `string` | no | — |
| `body` | `body` | — | `CaptureRequest` | no | — |

| Type | Schema value | Source |
| --- | --- | --- |
| `CaptureRequest` | `captureRequestSchema` | `src/models/capture-request.ts` |
| `CapturedPayment` | `capturedPaymentSchema` | `src/models/captured-payment.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |


### getAuthorizedPayment

- **Signature**: `getAuthorizedPayment(request: Payments.GetAuthorizedPaymentRequest, options?: RequestOptions): ApiPromise<PaymentAuthorization, Payments.GetAuthorizedPaymentError>`
- **Wire**: `GET /v2/payments/authorizations/{authorization_id}`
- **Auth**: `oauth2`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `PaymentAuthorization`
- **Error**: `PaypalError` with `kind: "api"`, an instance of `Payments.GetAuthorizedPaymentError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [401] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"error500"` [500] no body · `"error4"` [default — any status no arm above covers] `Error` · `"undeclared"` [a `default`-matched body that did not fit `Error`] `rawBody: ArrayBuffer`

**Fields** — `Payments.GetAuthorizedPaymentRequest` (3):

| Field | Channel | Wire | Type | Req |
| --- | --- | --- | --- | --- |
| `authorizationId` | `path` | `authorization_id` | `string` | yes |
| `payPalMockResponse` | `header` | `PayPal-Mock-Response` | `string` | no |
| `payPalAuthAssertion` | `header` | `PayPal-Auth-Assertion` | `string` | no |

| Type | Schema value | Source |
| --- | --- | --- |
| `PaymentAuthorization` | `paymentAuthorizationSchema` | `src/models/payment-authorization.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |


### getCapturedPayment

- **Signature**: `getCapturedPayment(request: Payments.GetCapturedPaymentRequest, options?: RequestOptions): ApiPromise<CapturedPayment, Payments.GetCapturedPaymentError>`
- **Wire**: `GET /v2/payments/captures/{capture_id}`
- **Auth**: `oauth2`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `CapturedPayment`
- **Error**: `PaypalError` with `kind: "api"`, an instance of `Payments.GetCapturedPaymentError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [401] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"error500"` [500] no body · `"error4"` [default — any status no arm above covers] `Error` · `"undeclared"` [a `default`-matched body that did not fit `Error`] `rawBody: ArrayBuffer`

**Fields** — `Payments.GetCapturedPaymentRequest` (2):

| Field | Channel | Wire | Type | Req |
| --- | --- | --- | --- | --- |
| `captureId` | `path` | `capture_id` | `string` | yes |
| `payPalMockResponse` | `header` | `PayPal-Mock-Response` | `string` | no |

| Type | Schema value | Source |
| --- | --- | --- |
| `CapturedPayment` | `capturedPaymentSchema` | `src/models/captured-payment.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |


### getRefund

- **Signature**: `getRefund(request: Payments.GetRefundRequest, options?: RequestOptions): ApiPromise<Refund, Payments.GetRefundError>`
- **Wire**: `GET /v2/payments/refunds/{refund_id}`
- **Auth**: `oauth2`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `Refund`
- **Error**: `PaypalError` with `kind: "api"`, an instance of `Payments.GetRefundError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [401] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"error500"` [500] no body · `"error4"` [default — any status no arm above covers] `Error` · `"undeclared"` [a `default`-matched body that did not fit `Error`] `rawBody: ArrayBuffer`

**Fields** — `Payments.GetRefundRequest` (3):

| Field | Channel | Wire | Type | Req |
| --- | --- | --- | --- | --- |
| `refundId` | `path` | `refund_id` | `string` | yes |
| `payPalMockResponse` | `header` | `PayPal-Mock-Response` | `string` | no |
| `payPalAuthAssertion` | `header` | `PayPal-Auth-Assertion` | `string` | no |

| Type | Schema value | Source |
| --- | --- | --- |
| `Refund` | `refundSchema` | `src/models/refund.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |


### refundCapturedPayment

- **Signature**: `refundCapturedPayment(request: Payments.RefundCapturedPaymentRequest, options?: RequestOptions): ApiPromise<Refund, Payments.RefundCapturedPaymentError>`
- **Wire**: `POST /v2/payments/captures/{capture_id}/refund`
- **Auth**: `oauth2`
- **Request body**: `application/json` — the `body` field. **Optional**: omit it and the request carries no body and no `Content-Type` header at all
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `Refund`
- **Error**: `PaypalError` with `kind: "api"`, an instance of `Payments.RefundCapturedPaymentError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [400] `Error` · `"error2"` [401] `Error` · `"error3"` [403] `Error` · `"error4"` [404] `Error` · `"error5"` [409] `Error` · `"error6"` [422] `Error` · `"error500"` [500] no body · `"error7"` [default — any status no arm above covers] `Error` · `"undeclared"` [a `default`-matched body that did not fit `Error`] `rawBody: ArrayBuffer`

**Fields** — `Payments.RefundCapturedPaymentRequest` (6):

| Field | Channel | Wire | Type | Req | Default |
| --- | --- | --- | --- | --- | --- |
| `captureId` | `path` | `capture_id` | `string` | yes | — |
| `payPalMockResponse` | `header` | `PayPal-Mock-Response` | `string` | no | — |
| `payPalRequestId` | `header` | `PayPal-Request-Id` | `string` | no | — |
| `prefer` | `header` | `Prefer` | `string` | no | `"return=minimal"` |
| `payPalAuthAssertion` | `header` | `PayPal-Auth-Assertion` | `string` | no | — |
| `body` | `body` | — | `RefundRequest` | no | — |

| Type | Schema value | Source |
| --- | --- | --- |
| `RefundRequest` | `refundRequestSchema` | `src/models/refund-request.ts` |
| `Refund` | `refundSchema` | `src/models/refund.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |


### voidPayment

- **Signature**: `voidPayment(request: Payments.VoidPaymentRequest, options?: RequestOptions): ApiPromise<PaymentAuthorization, Payments.VoidPaymentError>`
- **Wire**: `POST /v2/payments/authorizations/{authorization_id}/void`
- **Auth**: `oauth2`
- **Request body**: none — no `Content-Type` header is sent
- **SDK-sent**: `header Idempotency-Key` (minted per call)
- **Returns**: `PaymentAuthorization`
- **Error**: `PaypalError` with `kind: "api"`, an instance of `Payments.VoidPaymentError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"error"` [401] `Error` · `"error2"` [403] `Error` · `"error3"` [404] `Error` · `"error4"` [409] `Error` · `"error5"` [422] `Error` · `"error500"` [500] no body · `"error6"` [default — any status no arm above covers] `Error` · `"undeclared"` [a `default`-matched body that did not fit `Error`] `rawBody: ArrayBuffer`

**Fields** — `Payments.VoidPaymentRequest` (5):

| Field | Channel | Wire | Type | Req | Default |
| --- | --- | --- | --- | --- | --- |
| `authorizationId` | `path` | `authorization_id` | `string` | yes | — |
| `payPalMockResponse` | `header` | `PayPal-Mock-Response` | `string` | no | — |
| `payPalAuthAssertion` | `header` | `PayPal-Auth-Assertion` | `string` | no | — |
| `payPalRequestId` | `header` | `PayPal-Request-Id` | `string` | no | — |
| `prefer` | `header` | `Prefer` | `string` | no | `"return=minimal"` |

| Type | Schema value | Source |
| --- | --- | --- |
| `PaymentAuthorization` | `paymentAuthorizationSchema` | `src/models/payment-authorization.ts` |
| `Error` | `errorSchema` | `src/models/error.ts` |



### searchTransactions

- **Signature**: `searchTransactions(request: TransactionSearch.SearchTransactionsRequest, options?: RequestOptions): ApiPromise<SearchResponse, TransactionSearch.SearchTransactionsError>`
- **Wire**: `GET /v1/reporting/transactions`
- **Auth**: `oauth2`
- **Request body**: none — no `Content-Type` header is sent
- **Returns**: `SearchResponse`
- **Error**: `PaypalError` with `kind: "api"`, an instance of `TransactionSearch.SearchTransactionsError` — **typed arms**, narrowed on `err.payload.kind`
- **Error arms**: `"searchError"` [default — any status no arm above covers] `SearchError` · `"undeclared"` [a `default`-matched body that did not fit `SearchError`] `rawBody: ArrayBuffer`

**Fields** — `TransactionSearch.SearchTransactionsRequest` (14):

| Field | Channel | Wire | Type | Req | Default |
| --- | --- | --- | --- | --- | --- |
| `startDate` | `query` | `start_date` | `string` | yes | — |
| `endDate` | `query` | `end_date` | `string` | yes | — |
| `transactionId` | `query` | `transaction_id` | `string` | no | — |
| `transactionType` | `query` | `transaction_type` | `string` | no | — |
| `transactionStatus` | `query` | `transaction_status` | `string` | no | — |
| `transactionAmount` | `query` | `transaction_amount` | `string` | no | — |
| `transactionCurrency` | `query` | `transaction_currency` | `string` | no | — |
| `paymentInstrumentType` | `query` | `payment_instrument_type` | `string` | no | — |
| `storeId` | `query` | `store_id` | `string` | no | — |
| `terminalId` | `query` | `terminal_id` | `string` | no | — |
| `fields` | `query` | — | `string` | no | `"transaction_info"` |
| `balanceAffectingRecordsOnly` | `query` | `balance_affecting_records_only` | `string` | no | `"Y"` |
| `pageSize` | `query` | `page_size` | `number` | no | `100` |
| `page` | `query` | — | `number` | no | `1` |

| Type | Schema value | Source |
| --- | --- | --- |
| `SearchResponse` | `searchResponseSchema` | `src/models/search-response.ts` |
| `SearchError` | `searchErrorSchema` | `src/models/search-error.ts` |
