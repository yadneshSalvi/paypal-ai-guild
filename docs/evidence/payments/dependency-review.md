# Toolkit dependency qualification

Observed 11 November 2026 against the committed candidate lockfile. Machine-readable counts, exact versions and lock hash are in `dependency-review.json`; the complete npm report is retained in ignored private evidence.

`npm audit --omit=dev` reports **11 affected packages: 10 high and one moderate**. This is an open release item. The earlier clean-audit observation preceded the PayPal Agent Toolkit installation and is superseded. A dependency not used by this adapter is still present in the installation.

## Narrow compatibility change

Guild pins official `@paypal/agent-toolkit@1.11.0` and `axios@1.21.1`. The only new Toolkit override is its `mathjs@15.2.0` dependency. The official one-tool schema remains intact; tests exercise real Toolkit OAuth and get_order transport through its shared CJS Axios adapter with bounded fixtures. A real root browser request also completed through Toolkit. No math or scripting tool is exposed. This establishes compatibility for the qualified read path, not general compatibility of every Toolkit adapter or tool.

The pre-existing `@vercel/cli-config` Zod override remains 4.6.7. Toolkit's internal Zod 3.25.76 and Zod-to-JSON-schema converter were not blindly forced onto a different major version. Guild independently validates its tool call with strict Zod 4.6.7, a 256-byte argument-string limit and the exact already-owned order ID.

## Observed loading and bounded execution

Native Node loading of `@paypal/agent-toolkit/openai` loads Toolkit, Axios, mathjs and its Zod schema path. It does not load LangChain, LangSmith, the AI SDK, jsondiffpatch, the OpenAI package or uuid in that observed module cache. Actual model selection uses the server's bounded OpenAI Responses request. The adapter exports exactly get_order; independent validation rejects other tools and resources before Toolkit dispatch.

The supported `axios/dist/node/axios.cjs` entry shares Toolkit's actual CJS transport. A request-local guard permits only sandbox OAuth POST and GET of the selected owned order, without redirects, with 15-second timeout, 1 MB response and 8 KB request bounds. Responses are independently parsed and reduced to masked references, exact USD amounts, status, time and body hash. Debug logging is rejected. No payer or merchant personal data is sent back to the model or returned in public evidence.

## Remaining findings and follow-up

The installed flagged tree includes @ai-sdk/provider-utils, @ai-sdk/react, @ai-sdk/ui-utils, ai, jsondiffpatch, @langchain/core, langsmith, uuid, openai, zod and their Toolkit parent. Relevant advisories include [Zod constrained-collection memory consumption](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [LangChain serialization injection](https://github.com/advisories/GHSA-r399-636x-v7f6), [jsondiffpatch prototype pollution](https://github.com/advisories/GHSA-j4fx-xxwh-2485) and [AI SDK provider-utils resource consumption](https://github.com/advisories/GHSA-866g-f22w-33x8). These URLs and affected ranges come from the actual npm audit report.

The limited tool input, output and import path reduce the exposed behavior of this particular reader. They do not establish that the full dependency set is safe, erase audit findings or justify untested cross-major overrides. Reassess the installation and qualification before exposing additional tools/adapters or accepting broader inputs. No portfolio-wide audit fix or clean-audit result is claimed.
