# Phase 09 - Parallel Research Domains, Keyed Reducer/Join, Failure Tags, and Failed-Subset Retry

Status: implementation-phase specification, planning-only; contains no application code.
Authority: `12-implementation-roadmap.md` is the gate authority; contracts are owned by `02`-`11`; this file instructs and never redefines.
Executor: coding agent. Analysis -> implementation -> verification -> STOP before Phase 10.

## 1. Goal

Replace Phase07's serial production research with six Send domains, keyed reducer/join, deterministic-first ranking, tagged known failures and failed-subset retry. Retain the separate Phase05 harness; do not promote test-only nodes into production. Prove C/D under the canonical 2-attempt bound.

## 2. Prerequisites

- P01-P08 accepted; all common commands green; `AI_MODE=fixture` default.
- P04: provider interfaces (`AccommodationSearchProvider`, `RestaurantSearchProvider`, `AttractionsProvider`, `EventsProvider`), snapshots, `computeDomainHashes` with separate `flights/hotels/breakfast/lunch/dinner/activities/events` hashes, Stage B binding the flight-domain version/hash, deterministic fault overlays.
- P05: durable worker, `Send`/superstep semantics, pending writes on abort, `null` recovery, `Overwrite` reset pattern, event persistence.
- P07: hotel/meal/service pages that consume refreshed ranked IDs without touching reservations.
- P08: `recommendation` role configured for optional tradeoff ranking (deterministic default stays binding).

## 3. Source Inputs (authoritative)

- `03-langgraph-design.md` sections 4, 5, 6, 9, 10: node contracts, parallel research/reducer contract, routing, retry ownership, invalidation matrix rows for provider failure and preference-only changes.
- `05-synthetic-data-design.md` sections 7, 11, 12: determinism/extension rules, provider interfaces and tagged results, scenario controls C/D.
- `04-domain-model.md` sections 4, 5: fingerprint scope per domain, offer membership.
- `06-ai-agent-design.md` sections 1, 5: recommendation role output bounds (optional call).
- `11-testing-strategy.md` sections 6.2, 6.5, 14 (P09 gate).

## 4. Binding Decisions (do not re-decide)

- Domains are exactly `hotel`, `breakfast`, `lunch`, `dinner`, `attractions`, `events`. Meals stay split so a dinner-only change never reruns breakfast/lunch.
- Dispatch uses `Send("research_domain", { domain, researchRunId, ...validatedRefs })` plus a single static edge into `join_research`. Never route the same node through both a static edge and `Command(goto)`; never build an all-branches static barrier for selective work. Zero affected domains route directly to the next serial node with no dangling fan-in.
- Reducer contract: merge unique `researchRunId:domain` keys; an equal key may be replaced only with the identical idempotent result; conflicting same-key results are rejected. Result ordering is not meaningful; sort by domain for display. Each task writes only its own keyed result and artifact.
- `join_research` verifies every scheduled key exists and retains prior-domain refs whose fingerprints still match. A domain's result is a small tagged ref (`ok`, `unavailable`, `retryable_error`, `unsupported`), not a dataset.
- Known provider failure is a tagged domain result, so successful siblings still join. Automatic retry creates a new research-run scope (idempotent under the dispatch effect key) and sends only the failed domains; total provider attempts per affected domain per operation <= 2; unknown exceptions keep completed pending writes and `null` recovery reruns only unfinished tasks.
- Fault injection alters provider/validator behavior through the persisted overlay only; never regenerate an inventory. Injection counters and labels survive retries and restarts; every injected fault reads `Simulated failure` in events/UI.
- Fingerprint scope: Stage B binds the flight-domain version/hash, never the overall snapshot version; meal recommendation fingerprints use the relevant meal-domain hash plus effective preferences; recommendation artifacts store their input fingerprint. Extending dinner inventory must not invalidate flights or other meals (append-only snapshot extension preserves prior IDs/hashes).
- `rank_recommendations` filters deterministically first (membership, category eligibility against the proposal's bound target, dates/party/price); an optional `recommendation` AI call may only reorder supplied IDs with bounded reasons. Invalid IDs or price/category claims inconsistent with supplied data reject the result; the deterministic filter remains binding.
- No interrupts inside parallel research; no LLM call inside a research task. Provider calls are read-only plus idempotent artifact writes.
- HTTP `202` remains "queued": domain outcomes render only from persisted events/projection.

## 5. Detailed Ordered Steps

1. Define the production graph state extension: `requiredDomains`, `researchRunId`, and the keyed `researchResults` reducer channel with the identical-only same-key merge rule.
2. After confirmed valid flights, dispatch calls idempotent ScenarioService.ensureDomains once for missing inventories, persists one extension before Send, computes relevant hashes/run scope and sends affected tasks. Version0/unmaterialized is not unavailable; tasks never race to extend snapshots. Zero work routes directly.
3. Implement `research_domain`: validate refs, call the Phase 04 provider for one domain, persist the tagged result/artifact idempotently, catch only known simulated/provider errors as tagged results, and let unexpected errors abort the superstep.
4. Implement `join_research`: verify the expected key set, merge retained successes, gate necessary domains, and compute the failed-domain retry scope (new run ID) when attempts remain.
5. Implement `rank_recommendations`: deterministic filter/order; optional `recommendation` role reorder with strict schema validation; persist the recommendation artifact with its input fingerprint.
6. Wire routing back into the production graph: successful initial hotel research -> prepare hotel decision; program-selected refresh -> plan/summary per matrix; search-only -> summary.
7. Extend hotel/meal pages for empty/failed states: scenario C shows no compatible hotel with flights preserved; scenario D shows a `Simulated failure` label, siblings rendered, and a retry action that submits `retry_failed_domains`.
8. Emit domain timing/attempt events (start, finish, duration, attempt, fault label) sufficient to prove overlapping execution and one join; keep payloads small and safe.
9. Add invariant coverage: a dinner-only override changes only the dinner artifact hash and reruns neither breakfast nor lunch; sibling reservations/hashes unchanged under C/D.

## 6. Concrete Target Paths

```text
packages/workflow/src/nodes/{dispatch-research,research-domain,join-research,rank-recommendations}.ts
packages/workflow/src/state/research-reducer.ts
packages/domain/src/research/{affected-domains,retry-scope,gate}.ts
packages/data/src/providers/{accommodation,restaurant,attractions,events}.ts   # wire Phase 04 implementations
packages/persistence/src/{recommendations,faults}.ts
packages/persistence/migrations/0009-research.sql  # required ALTER/index only, no duplicate CREATE
apps/web/src/app/trips/[id]/hotel/page.tsx        # empty/retry states
apps/web/src/app/trips/[id]/meals/page.tsx        # per-meal refresh/retry states
tests/integration/research/{parallel-timing,reducer,retry-subset,faults-cd}.test.ts
tests/e2e/phase-09.spec.ts
```

## 7. Functions and Interfaces to Implement

| Contract | Input -> Output | Required failure behavior |
| --- | --- | --- |
| `dispatchResearch(ctx)` | current fingerprints + failed scope -> `Send[]` or direct continuation | idempotent run scope under the dispatch effect key; zero domains never wait on fan-in |
| `researchDomain(one TaskInput)` | domain + refs -> tagged result + artifact | known provider errors tagged, unexpected errors abort the superstep |
| `joinResearch(state)` | scheduled keys -> merged retained results or retry scope | missing scheduled key -> typed failure; conflicting same-key results rejected |
| `rankRecommendations(ctx)` | valid candidates + preferences -> ordered IDs + reasons | deterministic filter binding; invalid AI IDs/claims rejected |
| `recordFaultOutcome(tx, { tripId, operationId, domain, fault })` | persisted overlay counters -> updated state | survives retries/restarts; never regenerates inventory |

## 8. Outputs / Deliverables

- Genuine `Send` fan-out over six independent domains with a single superstep join and keyed reducer.
- Failed-subset retry with new run scope and <= 2 attempts per affected domain.
- Scenarios C and D observable end to end; evidence of overlapping task timings.
- Domain-hash isolation: unrelated domains and reservations unchanged by a single-domain change.

## 9. Measurable Acceptance Criteria

- AC-09-1: parallel domain tasks overlap in real timings/events and join once (T-IT-RED-01, timing evidence).
- AC-09-2: reducer rejects conflicting same-key results; equal keys replace only identical idempotent results; zero domains continue directly (T-IT-RED-02).
- AC-09-3: scenario D: the first hotel call fails transiently, breakfast/lunch/dinner/attractions/events succeed, the retry sends only `hotel`, hotel attempts <= 2, sibling hashes unchanged (T-IT-RET-01).
- AC-09-4: scenario C: hotel provider returns an empty compatible set; the confirmed flight remains, no itinerary starts, and the UI explains the gap with alternatives (C assertion).
- AC-09-5: an abort in one branch keeps completed siblings' pending writes; `null` recovery reruns only unfinished tasks (T-IT-RET-02).
- AC-09-6: dinner-only change alters only the dinner hash and reruns neither breakfast nor lunch; meal/domain hashes and reservation IDs unchanged.

## 10. Commands and Tests

```text
npm run typecheck
npm run lint
npm run test:unit
TEST_DATABASE_URL=... npm run test:integration
npm run build
npm run test:e2e -- --grep "phase-09"
```

Tests (P09 gate): T-IT-RET-01/02; T-IT-RED-01/02; scenario C and D assertions; phase-local parallel-timing and hash-isolation tests. Never back-date tests.

## 11. Explicit Out of Scope

- Itinerary planner/validator/reviewer, timeline/map/costs, scenarios E/F/G: P10.
- Full invalidation matrix/re-entry hardening, inspector, SSE replay hardening: P11.
- Final regression/security/restart evidence, runbook, live criterion 28: P12.

## 12. Common Mistakes / Traps

- Always fanning out all six domains instead of only affected ones; rerunning breakfast/lunch for a dinner change.
- Building a static six-branch barrier or mixing static edge and `Command(goto)` on one node.
- Clearing reducer state with `{}` (it does not clear a map) or clearing from a parallel worker.
- Reusing the same run scope for a retry, causing a same-key conflict instead of a new success.
- Counting attempts per node instead of per affected domain per operation; retrying siblings.
- Regenerating an inventory or snapshot to "fix" a provider fault; losing fault counters on restart.
- Binding Stage B or booking approval to the whole snapshot version; recomputing hashes from the whole trip.
- Letting the optional recommendation AI call override the deterministic eligibility filter.

## 13. Completion Checklist

- [ ] Read instructions/memory; state active invariants before editing.
- [ ] Real six-domain fan-out, keyed reducer, single join, and zero-domain direct continuation implemented.
- [ ] Tagged failures, failed-subset retry, and persisted fault overlay implemented (C/D).
- [ ] Domain-hash isolation asserted; no reservation or inventory regeneration.
- [ ] Section 10 commands/tests executed with captured output; gaps reported honestly.
- [ ] Only phase-scope files changed; no commits; STOP before Phase 10.

## 14. Pasteable Executor Prompt

```text
Implement ONLY Phase 09 of the AI Travel Planner in this repository (docs/planning/phases/phase-09.md).

Analysis first (no code changes): read AGENTS.md and agent-memory/index.md, then the phase file,
docs/planning/03-langgraph-design.md (sections 4-6, 9-10), 05-synthetic-data-design.md (sections 7,
11, 12), 04-domain-model.md (sections 4-5) and 11-testing-strategy.md (sections 6.2, 6.5, 14).
Inspect the Phase 04 providers/snapshots and Phase 05 harness reducer semantics. Report the plan,
affected paths, and any contract conflict. Modify nothing in this pass.

Implementation: genuine Send fan-out for the six domains hotel/breakfast/lunch/dinner/attractions/
events with a keyed reducer researchRunId:domain and one static edge into join_research; zero
affected domains continue directly; known provider failures are tagged results so siblings join;
automatic retry uses a NEW run scope and sends only the failed subset with total provider attempts
per affected domain per operation <= 2; fault overlays are persisted and never regenerate
inventory; Stage B binds the flight-domain version/hash (not the overall snapshot version) and meal
hashes stay independent; deterministic ranking is binding with an optional bounded recommendation-
role reorder; no interrupts or LLM calls inside research tasks. Scenarios C (hotels unavailable,
flight preserved) and D (transient first hotel failure, siblings retained, hotel-only retry) must
be observable. Do not implement itinerary planning, inspector, or later-phase features; do not
change contracts or add architecture; no commits.

Verify: run typecheck, lint, test:unit, test:integration (TEST_DATABASE_URL), build, and the
phase-09 E2E subset; execute the tests in phase-09.md section 10 and capture exact output; check
AC-09-1..6 and the section 13 checklist. Provide timing evidence for overlapping tasks.

Report to the user in Czech: files changed, commands/results, acceptance status, incomplete work,
remaining risks, proposed memory updates only. Then STOP. Do not start Phase 10.
```
