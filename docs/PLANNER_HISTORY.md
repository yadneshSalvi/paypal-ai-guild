# Saved planning conversations

The production-floor planner restores its visible conversation from retained server records. Opening, reloading or loading a saved conversation only reads those records. It does not create a model response, poll a provider, execute a tool, prepare a proposal or approve a Passport.

## Canonical input

New requests use `guild.planning-request.v2`. The browser may submit an explicit new user message or the exact ordered IDs of the preceding response's pending tool calls. It also supplies the conversation, request and immediate parent identities. Assistant messages, tool arguments and tool-result text are never accepted from a browser transcript.

The server rebuilds every prior turn from its saved request intent, actual response and exact matching tool-result rows. It checks the request hash, parent chain, canonical input hash, call name, arguments and result identity. A copied transcript with a recomputed hash is insufficient: it must still equal that reconstructed history. Missing, invented, omitted, reordered or stale calls stop before a new provider request. A new user message cannot skip unresolved tools. The native `askUser` result must be retained before the owner's answer can continue the conversation.

All six supported tools have durable results: `askUser`, `createPlan`, `getOpeningPlan`, `compareRecoveryQuotes`, `proposeOpeningChange` and `completePlanSteps`. A completed plan step requires its matching successful application result and native completion record. The proposal tool creates a reviewable proposal; preparation and Passport approval remain separate owner actions.

Migration 015 adds nullable request-intent and canonical-input-hash fields. It does not rewrite earlier requests, results or digests. Earlier conversations remain readable but cannot lend their browser-originated acknowledgments to a new canonical request. Continuing that work requires an explicit new conversation. Current authority and source checks still govern all new work.

## Restoration and recovery

The read-only conversation endpoint projects public user messages, actual assistant replies, the saved question and choices, and the last retained plan with evidence-backed step states. Intermediate tool transcripts stay in the evidence view. Assistant replies use a bounded display-only Markdown subset through the native formatting hook: headings, emphasis, lists, code and semantic comparison tables. Raw HTML, images, links and native mention tokens remain inert. Canonical saved text is unchanged, and unsupported syntax remains visible as text.

Reload before a pending owner choice restores that choice. Reload after the final reply restores the public conversation and completed checklist. An unfinished model response or unresolved non-question tool sequence remains visibly held. Restoration never automatically resumes it. A known original response can still be inspected through the existing saved-response controls; an uncertain create is never replaced silently.

**New conversation** creates only a local conversation identity and reloads. It does not delete earlier records or bypass an outstanding request. **Load conversation in planner** selects a retained conversation for the next panel opening without another model call. The complete saved count remains visible, with singular/plural labels matching the count. When the planning provider is unavailable, the native panel still opens retained conversations and plans. New messages, actions and new-conversation controls are disabled, with an explicit availability notice; no dummy credential is needed to read history.

The pinned Bryntum 8.0.0 chat factory normally switches to a collapsed bottom drawer when created on a narrow screen. Guild uses one actual native `AIChatPopup` at every width, preserving native ownership, input, messages, plan controls and focus behavior. Its dimensions and viewport position update on opening and resize; the transcript gets the remaining flexible height. This per-button adapter must be requalified when the native package changes.

## Historical narration under a later plan

Retained narration is validated against the immutable approval snapshot and command that produced its exact artifact. A later commercial total does not change that original agreement. The validator checks the original production command, job, contract amendment, approval receipt signature, approval command snapshot, source/input bindings, artifact hash and speech/assembly identity. Each historical producing agreement in a carried lineage is checked independently.

Historical reads use authority at the original production instant. They do not grant dispatch authority now. A new request still requires the current exact contract, current approval, current sources and an unexpired authority envelope. Missing or altered historical snapshots, invalid signatures and mismatched lineage fail closed. Original rows, signatures, content hashes and expiry are never rewritten.

## Evidence boundary

The focused PostgreSQL controls cover forged browser transcripts, rehashed saved-history changes, omitted and reordered calls, missing historical tool results, fabricated completion, legacy restoration, tenant isolation, pending reload and historical narration under a changed commercial total. The broad source unit passed 60 domain tests and 118 PostgreSQL checks. Native restoration uses a labelled synthetic model transport and real widgets/application handlers. A later actual-model qualification completed eight GPT-6.1 Sol responses with max reasoning, seven saved tools and one $580 proposal under controlled fixture inputs. It preserved the active $540 plan, original approval and zero production/financial actions; see the [actual planning receipt](evidence/planner-live-qualification.json). Hosted parity, clean installation and broad accessibility/performance qualification remain separate gates.

Exact source binding, native measurements, retained findings and remaining gates are in the [history qualification record](evidence/scheduling/native-history-qualification.json). The earlier [scheduling integration record](evidence/scheduling/native-integration-qualification.json) remains unchanged and describes the earlier release.

The separate [formatting and unavailable-provider history check](evidence/scheduling/planner-formatting-qualification.json) reads that retained actual output with provider credentials absent. Desktop/mobile restoration, a keyboard-scrollable table, disabled new input and Escape focus passed without new requests or decisions.
