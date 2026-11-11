# The production floor

Guild's production floor connects Bryntum Gantt and unified Scheduler Enterprise 8.0.0 to one native ProjectModel. The two views share task/event, resource, assignment, dependency and calendar stores. A saved schedule is a forecast from current contracts and source artifacts; it does not report work as completed or authorize production.

The timeline shows the opening, critical path and retained planning baseline. A task table and earliest-start form provide a keyboard alternative. Dates in task details use the museum's `America/New_York` time zone; the timeline identifies its display zone separately. Native dragging cancels the store mutation and submits an immutable proposal for server calculation. Previewing that proposal leaves the active schedule unchanged.

## Contracts, offers and approval

The strict `guild.schedule.v1` model contract remains unchanged. `guild.schedule.v2` wraps that model with tenant/commission identity, current package and acceptance-pack versions, input artifact hashes, provider policy/capacity, original quote terms, calculation and revision digests. Each server preview calculates a separate native project, checks the complete source revision and destroys the temporary model afterward.

Recovery offers are signed by Guild's team-operated provider service. They are controlled service offers, not unaffiliated-provider negotiation or observed fulfillment. Issuance requires the current failed blocking web report and its exact artifact. The signed terms bind the report, provider policy, current contract, price, service fee, working duration, calendar, capacity, earliest start and real expiry. The opening-week dates below are modelled business dates.

| Controlled offer | Provider award | Service fee | Work | Review finishes, museum time | Opening margin |
| --- | ---: | ---: | ---: | --- | --- |
| Formwork economy | $130 | $15 | 24 working hours | Mon 23 Nov, 11 am | 9 working hours late |
| Ostrava accessible | $160 | $15 | 8 working hours | Thu 19 Nov, 11 am | 7 working hours before opening |

Both calculations include four working hours of curator review. The accessible option finishes review 23 elapsed hours before the Friday 20 November, 10 am opening. The complete proposal changes from $540 to $580 within the $640 ceiling. The $160 award and $175 package gross remain separate.

An offer expires after at most twenty real minutes, bounded by the original workspace and Passport deadlines. Review creates a retained proposal; an explicit acknowledged preparation creates a new schedule and, for changed provider terms, a new package contract. It preserves the failed submission/report and releases only the superseded unaccepted reservation. It clears approval and leads to the separate fresh Passport. No production job, acceptance or payment is created by preparation.

An approved offer keeps its original signed terms after its offer window. That approval must match the immutable approved commission snapshot containing this exact quote and contract. Another valid receipt cannot lend it authority. A prepared but unapproved expired offer needs an explicit renewed offer, a retained link to its previous signed terms/report, another contract/schedule revision and fresh Passport. Renewal cannot extend the original authority ceiling. Changes to source, calendar or capacity require a current-source reconciliation preview. The Passport displays the earliest effective deadline separately from each page's expiry.

New production binds the exact schedule in its durable job. Enqueue, provider dispatch and artifact publication check it again. Stale source or capacity, a different schedule, revocation, expired authority or missing approval stops new work; original results remain available for review.

## Native planning assistant

The installed native Bryntum panel uses `askUser`, `createPlan` and `completePlanSteps`, with three application tools: `getOpeningPlan`, `compareRecoveryQuotes` and `proposeOpeningChange`. Generic native store mutators are excluded. Plan completion requires the corresponding successful server tool result. The native plan's actual state drives a visible checklist in the panel, including the completed final state.

The server selects `gpt-6.1-sol` with max reasoning and background Responses. It admits only canonical tools available in the current native plan phase. A tool invocation must match an exact saved response, call ID and arguments. The proposal tool is idempotent and does not prepare or approve a Passport, request a provider offer, dispatch production, accept an artifact or move money.

Each request reserves one original create identity. Known response IDs are polled; an uncertain create is held without an automatic replacement. Closing the panel retains the request. A conversation has a 24-create ceiling; another conversation is explicit and cannot bypass pending or uncertain work. Paginated history shows the complete saved count and original results. The native popup restores public messages, saved question options and the evidence-backed checklist through a read-only endpoint. Loading a retained conversation makes no model or tool call. Unfinished work stays visibly held. Actual model behavior requires its own controlled qualification; the native browser fixture uses a clearly labelled local synthetic transport.

The v2 request contract accepts only a new user message or exact pending call IDs. The server reconstructs earlier assistant calls and tool outputs from matching saved rows and checks every parent/hash/result relationship; it never forwards a browser-provided tool transcript. Legacy conversations remain readable without rewriting their digests or replaying their tools. [Saved planning conversations](PLANNER_HISTORY.md) describes the input boundary, native restoration, responsive popup and original-approved-snapshot narration validation.

## Evidence and reproduction

Run with the existing pinned dependencies and a dedicated disposable-test database:

```sh
npm run typecheck
npm test
npm run test:integration
npm run build
node_modules/.bin/tsx scripts/qualify-scheduling.ts
```

The original [model qualification](evidence/scheduling/native-model-qualification.json) covers critical paths, both baseline-variance signs, a thirty-minute capacity collision, provider time off, both daylight-saving transitions, invalid graphs, impossible calendars, bounded horizons and immutable parallel evaluation. It remains attached to its original source hashes.

The first integrated suites passed 60 domain/transport and 107 PostgreSQL tests. The revised focused suite passes 13 scheduling/assistant tests, adding exact approval-snapshot binding, original-deadline projection, worker holds before any provider call, per-request native tool admission and complete paginated history. Strict TypeScript and isolated production/QA builds pass. The complete final rerun passed 60 domain and 110 PostgreSQL tests. Exact source hashes and native outcomes are in [the integration record](evidence/scheduling/native-integration-qualification.json).

The first root-operated native pass established shared stores/selection, view-tab keyboard controls, two retained proposals, exact commercial review, mobile proposal layout and normal separate Passport approval. A read-only audit found schedule r2, web v2, $580 within $640, the old $135 reservation released, both approvals and the original failed artifact/report retained, and zero production/financial activity. The synthetic assistant made exactly nine creates and nine known-ID reads. That pass found four presentation failures: hidden native plan steps, an eight-item history cap, async focus return and native dark styling; time-zone and effective-deadline labels also needed clarification. Those findings are retained. The separate retest passed actual pointer dragging with the active r1 model unchanged, bar/form focus return, museum-time labels, a visible three-step native checklist, all nine saved responses, the effective-deadline display and the 390px popup. A final targeted pass confirmed cream backgrounds and readable text on the popup body/input at desktop and mobile widths. No extra planning request or approval was needed for that style check.

The subsequent [canonical history qualification](evidence/scheduling/native-history-qualification.json) passed 60 domain and 118 PostgreSQL checks, including nine planner and nine narration/history cases. Root restored the exact two-choice question before answering, then four public messages and the completed checklist after the final response. New conversation followed by loading saved history made no request. The final actual popup passed 390×844 → 1280×720 resizing and close/reopen, with a usable message area, cream input, dark close icon and Escape focus return. Its read-only fixture remained at nine synthetic creates, nine reads, eight tools, one unprepared proposal and the original $540/schedule r1. The previous integration report and source digests remain unchanged.

The native packages expose some experimental hooks and internal allocation APIs only in installed source. Narrow declarations match the pinned 8.0.0 implementation. A package upgrade requires repeating engine, browser, lifecycle, tool-boundary and license checks. The local builds reuse installed dependencies; clean install, hosted parity, actual model transport, broader accessibility/performance and deployment remain open.

## Remaining product gates

Actual captions/easy-read and generated-web producers and independent checks remain required. Historical narration now validates its original approved snapshot across later commercial plans; this source qualification does not migrate an existing runtime or renew expired authority. Genuine Formwork evaluation, seven addressed services, bilateral A2A, MCP commissioning, signed AP2-shaped exports, human acceptance, real captures/payouts/closure, provider onboarding, standing-wallet consent, recourse, broader evaluations and the release/film remain required. The [capability ledger](capabilities/guild.json) keeps implementation, observed evidence and remaining gates separate.
