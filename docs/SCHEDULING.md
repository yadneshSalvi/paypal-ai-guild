# Native scheduling model qualification

Guild now evaluates isolated schedule snapshots with the installed Bryntum Gantt Enterprise 8.0.0 engine. The result is a modelled forecast. The current unit does not connect a Gantt or Scheduler view to the studio, accept a provider offer, change an approved plan, or authorize work or payment.

The qualification fixture uses `America/New_York`, Monday–Friday 09:00–17:00, a Tuesday 17 November 2026 15:00 replacement start, four working hours of curator review and a Friday 20 November 10:00 opening. The source and returned instants are UTC; the dates below are local museum time.

| Modelled option | Provider price | Working duration | Replacement finishes | Review finishes | Opening margin |
| --- | ---: | ---: | --- | --- | --- |
| Economy | $130 | 24 hours | Fri 20 Nov, 15:00 | Mon 23 Nov, 11:00 | 73 wall-clock hours late; 9 working hours late |
| Accessible | $160 | 8 hours | Wed 18 Nov, 15:00 | Thu 19 Nov, 11:00 | 23 wall-clock hours early; 7 working hours early |

The amounts are fixture estimates, not authenticated quotes. Calendar time never substitutes for real quote or authority expiry. The engine calculates the critical path as replacement → curator review. Critical-path slack is relative to calculated project completion; opening margin is a separately named result. The earlier image finish produces a native baseline variance of **+2 working hours**. Its agreed downstream earliest start remains Tuesday 15:00. A separate test produces **−2 working hours** of baseline variance.

`src/scheduling/contracts.ts` defines a strict versioned snapshot: bounded IANA calendars, dated unavailability, tasks, resource capacity, finish-to-start dependencies, original baselines, opening and completion. It rejects duplicate or missing references, cycles, omitted paths to completion, unspecified-zone timestamps and injected authority fields. Every task must feed the completion task. This first contract deliberately admits only disclosed modelled fixtures; production-backed schedule and quote bindings need an explicit extension.

`configuration.ts` produces the single native ProjectModel configuration for later shared views. `model.ts` makes a new project for each evaluation, waits for engine calculation, reports the calculated dates/critical paths/baselines and destroys the project. Source snapshots remain unchanged, including concurrent evaluations. Empty calendar intersections cancel; calculated work outside the bounded horizon is rejected.

Capacity uses Bryntum's actual Enterprise allocation report through the same engine path as its ResourceHistogram. Allocation intervals split at task and working-calendar boundaries, so a thirty-minute collision is not hidden by a daily average. A regression establishes a 200-unit simultaneous workload against 100-unit capacity and confirms that explicit 200-unit capacity clears it. The adapter reports a conflict rather than silently moving work to another slot. Resource time off is included in native task calculation; making Wednesday unavailable pushes the otherwise feasible option's review to Friday 11:00, one hour late.

The public declaration bundle omits a few native allocation internals and provides generic Store record types. Narrow local declarations and boundary casts match the installed 8.0.0 implementation. Upgrading Bryntum requires repeating this qualification. Rendering, browser license behavior and shared widget lifecycle are not established by Node execution. The official [ProjectModel documentation](https://bryntum.com/products/gantt/docs-llm/api/Gantt/model/ProjectModel.md) describes asynchronous scheduling and project stores; the installed package source and executable tests establish the behavior reported here.

## Reproduce

With the existing pinned Enterprise dependencies installed:

```sh
npm run typecheck
npm test
node_modules/.bin/tsx scripts/qualify-scheduling.ts
```

The final run passed **55 domain/transport tests**, including **10 native scheduling cases**, and strict TypeScript checking. Scheduling tests include both daylight-saving transitions, provider time off, a thirty-minute capacity collision, both signs of baseline variance, immutable parallel evaluation, invalid graphs, impossible calendar intersections and horizon rejection. No database or provider credentials are needed. The earlier 90 PostgreSQL cases apply to the frozen narration release; they were not rerun for this isolated, unrouted module.

[`evidence/scheduling/native-model-qualification.json`](evidence/scheduling/native-model-qualification.json) contains the actual engine results, exact package versions and SHA-256 hashes of the qualified source, test and runner. A full application build is not new evidence for this unit: it has no imported product route or view yet.

## Required continuation

Connect Gantt and Scheduler Enterprise to one actual project instance and qualify their shared stores, resource calendars, opening marker, native critical-path/baseline display, responsive layout, keyboard controls and lifecycle. Add revision-bound persisted schedule proposals and server-side clone validation. Bind genuine offers, scope, prices, working duration, provider calendar/capacity and real-time expiry before a candidate can be selected or approved.

Then compile the installed native AI panel and custom tools through the validated proposal gateway. Remove generic mutation tools that bypass application commands. The panel, `askUser`, `createPlan`, `completePlanSteps` and optional tool adapter have not been qualified in this unit. The documented [native AI feature](https://bryntum.com/products/scheduler/docs-llm/api/Grid/feature/AI.md) remains the target. Complete production, human acceptance, financial, protocol, provider, accessibility, evaluation and release requirements remain in force.
