# Phase 11 - Full Selective Invalidation, After-END Re-entry, Preservation, Durable SSE, Graphical Inspector (Scenarios H, I, J, K)

Status: implementation-phase specification, planning-only; contains no application code.
Authority: `12-implementation-roadmap.md` is the gate authority; contracts are owned by `02`-`11`; this file instructs and never redefines.
Executor: coding agent. Analysis -> implementation -> verification -> STOP before Phase 12.

## 1. Goal

Complete the production behavior of selective change: implement the full invalidation matrix as graph dispatch, harden after-END re-entry on the same trip thread, prove preservation of confirmed bookings/content hashes/override inheritance/pace/numeric requirements, finish durable SSE replay semantics, and deliver the graphical execution inspector. Prove scenarios H (cheaper same-category hotel), I (global Luxury with budget breakfast), J (Intensive -> Relaxed), K (browser closed at a pending decision).

## 2. Prerequisites

- P01-P10 accepted; all common commands green; `AI_MODE=fixture` default.
- P03: effect ledger, proposals/reservations, partial unique indexes.
- P05: invocation contract (`chooseInvocation`, `null` recovery, plain new-run input after `END`), `Overwrite` reset pattern, fenced saver, event storage with monotonic IDs, SSE route and polling fallback.
- P08: clarification persistence, requirement conversion, category-preserving `find_alternatives`.
- P09: per-domain hashes and affected-domain computation.
- P10: itinerary versions, validation/review, approval.

## 3. Source Inputs (authoritative)

- `03-langgraph-design.md` sections 3, 6, 8, 10: state ownership, routing table, invocation/recovery contract, invalidation matrix.
- `04-domain-model.md` sections 2, 3, 6, 7, 9, 11: overrides, trip aggregate, commands, decisions, SQL constraints, invariants.
- `07-conversation-and-intents.md` sections 3, 8: interpretation rules, re-entrant interaction.
- `08-frontend-ux.md` sections 8, 10, 11, 14, 15: assistant, inspector, accessibility, states, acceptance hooks.
- `10-security-reliability.md` sections 2, 4, 8, 9: sessions, CSRF, inspector redaction, error taxonomy.
- `11-testing-strategy.md` sections 6.5, 7, 8, 14 (P11 gate).

## 4. Binding Decisions (do not re-decide)

- Matrix semantics are exact: `R` refreshes recommendations only, `V` validates dependent logistics, `P` creates a new itinerary proposal, `X` requires explicit impact confirmation before incompatible booked state changes, `-` preserves the domain and its content hash. Rows follow `03` section 10; route-input changes always rerun Stage A/B and require `X` for incompatible reservations.
- Recompute fingerprints from the exact relevant inputs, never the whole trip object. Changing breakfast level cannot make flight/hotel data appear stale; Stage B binds the flight-domain version/hash, not the overall snapshot version; meal hashes stay split.
- Re-entry after `END`: a new authorized request invokes plain new-operation input and begins again at `START` with persisted state. Never use input `Command({update})`, never use `null` to start a modification, and never run a second invocation beside a pending one. New runs reset per-operation counters and work scope through a serial-node `Overwrite`; reducer scopes are pruned/replaced, never cleared from a parallel worker.
- While a decision is pending, only supported answers/modifications are admitted; the worker resumes that exact interrupt with a typed internal `modify` reference built from an admitted operation, explicitly resolves/cancels the old decision, and then applies the command. Partial user changes while another operation is queued/running are rejected `409 OPERATION_IN_PROGRESS`, not queued and interleaved.
- Unfinished failed work rejects ordinary input with RECOVERY_REQUIRED. Technical retry keeps the same operation/revision/scope and never resets provider/AI/planning counters or ignores a new request while null-resuming old work.
- `find_alternatives: cheaper` compares against the selected/confirmed party-total price and preserves that offer's category even when the global effective preference has since changed; only an explicit `level` changes the target category. Category eligibility is checked against the proposal's bound target. Without a selection, use the effective category plus a clarification or a shown budget cap.
- Preservation invariants: scenario H keeps flight/meal/activity hashes and booking IDs while the old hotel stays active until explicit confirmation; scenario I keeps hotel/lunch inherited Luxury while breakfast is an explicit Budget override and a dinner-only change reruns neither breakfast nor lunch; scenario J keeps flight/hotel/confirmed-meal IDs and fixed times/durations while only activity structure changes. Confirmed reservations change only through explicit decisions.
- `minimumActivityCounts` (tag -> 1..7, cleared by `null`) survive summarization, browser refresh, restart, and planning review; conflicts are clarified, never silently reduced. `null` dinner only with the deterministic no-slot result; a confirmed dinner is never removed.
- SSE is durable: persisted monotonic bigint event IDs serialized as decimal strings; authorize before replay; reconnect via `Last-Event-ID`/`after`; deduplicate by event ID; 15-second heartbeat; polling `GET /api/trips/:id` is the fallback. The SSE route runs on Node.js, is dynamic/unbuffered/non-cached, and terminates on disconnect. `LISTEN/NOTIFY` may be a latency hint only. A `202` never renders success.
- Inspector displays only safe projected fields: node names/status, attempts, checkpoint/interrupt IDs, resume operations, durations, LLM rows (role, model, prompt version label, tokens, estimated cost, validation status, retries), scenario mode, and faults labeled `Simulated failure`. Forbidden without exception: prompts, chain-of-thought or raw reasoning, provider payloads, SQL, stack traces, cookies, secrets, raw headers. Events are projected before persistence; the inspector cannot reveal what was never stored.
- Simulation controls (`set_simulation`) exist only with `DEMO_CONTROLS_ENABLED` and an owned trip, submit through the same validated command endpoint, and are visibly demo-only. Restart/browser-close recipes are operator instructions; the browser never executes server shell commands.
- After `409 STALE_REVISION` the UI refreshes and re-presents the current revision; it never automatically replays the old command or a rejected modification against changed state.

## 5. Detailed Ordered Steps

1. Implement the dispatch layer in `load_context`/`apply_commands`/`apply_decision` that maps an accepted change to matrix actions per affected domain and produces `nextWork` (`route`, `research`, `hotel_choice`, `program`, `plan`, `logistics`, `summary`, `decision`) without mutating unrelated refs.
2. Implement `commit_route_change` wiring: preview affected reservations, require `route_change_confirmation` naming the affected IDs, then supersede/cancel atomically and rerun both feasibility stages; a rejected route produces no booking.
3. Harden `chooseInvocation` re-entry paths for completed threads: plain new input from `START`, serial `Overwrite` reset of counters/work scope, preserved compatible artifacts and selections; keep resume only for the exact current interrupt.
4. Implement pending-decision modification admission: typed `modify` only from the worker, old decision resolved/cancelled explicitly, then command application through the normal dispatcher.
5. Implement the UI command admission behavior for active operations: `409 OPERATION_IN_PROGRESS` path, preserved typed form/message, deliberate resubmission only; stale revision refresh without auto-replay.
6. Harden event storage/SSE: decimal-string cursors, replay authorization, dedupe, heartbeat, disconnect/termination, polling fallback; assert no raw `values`/`debug`/prompt content is ever persisted or streamed.
7. Render an actual SVG node/edge graph plus details, not only tables. Persist safe graph.initialized metadata from the same worker builder registry; highlight real node/task events, checkpoints/resumes/timings/usage. DTO has no code; BFF/browser never call graph APIs. Simulation controls remain flag/owner protected.
8. Wire scenario H/I/J recipe actions through protected typed commands and assert preservation invariants with content-hash and reservation-ID comparisons.
9. Implement scenario K acceptance: close/reopen the browser at a pending decision; the exact descriptor reloads from the server and the resume completes the decision without duplicate effects.
10. Add invariant tests T-INV-04/07/11 and the P11 E2E subset; assert SSE/202 honesty and inspector redaction in DOM and persisted events.

## 6. Concrete Target Paths

```text
packages/workflow/src/routing/invalidation-matrix.ts
packages/workflow/src/nodes/{load-context,apply-commands,apply-decision,commit-route-change}.ts
packages/domain/src/selective/{affected-domains,fingerprint-scope,preservation}.ts
packages/persistence/src/{events,operations}.ts                    # extend
apps/web/src/app/trips/[id]/inspector/page.tsx
apps/web/src/components/inspector/{execution-graph,node-table,attempt-list,llm-call-table,fault-panel,simulation-controls}.tsx
packages/contracts/src/graph-definition.ts, packages/workflow/src/travel/graph.ts  # safe registry metadata
apps/web/src/lib/use-sse.ts                                     # extend replay/dedupe/heartbeat/fallback
apps/web/src/app/api/trips/[id]/events/route.ts                 # extend hardening
tests/integration/selective/{invalidation-hij,reentry,preservation}.test.ts
tests/e2e/{phase-11,inspector,sse-replay}.spec.ts
```

## 7. Functions and Interfaces to Implement

| Contract | Input -> Output | Required failure behavior |
| --- | --- | --- |
| `resolveInvalidation(change, currentRefs)` | accepted change -> `{ affectedDomains, itineraryAction, requiresConfirmation }` | matrix-exact; unrelated refs untouched |
| `commitRouteChange(ctx, decision)` | confirmed impact + affected IDs -> new route inputs + cancelled/superseded reservations | atomic; rejected route creates no booking |
| `chooseInvocation(state, operation)` (extend) | completed/waiting/crashed state -> exact invocation or typed conflict | never `Command({update})`; `null` only for unfinished tasks |
| `admitModification(ctx, operationRef)` | pending decision + admitted operation -> `modify` envelope or 409 | browser cannot supply operation identity; old decision resolved explicitly |
| `projectSafeEvent(event)` | internal event -> persisted public payload | redaction allowlist; forbidden fields never stored |
| `playEvents(tripId, after)` | authorized cursor -> ordered deduplicated events | authorize before replay; decimal-string IDs |

## 8. Outputs / Deliverables

- Complete invalidation matrix behavior with preservation proofs for H/I/J and exact-decision reload for K.
- Hardened durable SSE with replay/dedupe/heartbeat and polling fallback; 202 honesty asserted.
- Graphical inspector limited to safe projected fields, with protected simulation controls and labeled faults.
- Invariant and E2E evidence from section 10; run log and checklist report.

## 9. Measurable Acceptance Criteria

- AC-11-1: scenario H: a cheaper same-category hotel proposal appears; flights, meals, activity hashes, and booking IDs are unchanged; the old hotel stays active until explicit confirmation (T-E2E-04, T-INV-07).
- AC-11-2: scenario I: global Luxury plus budget breakfast leaves other meals and the hotel inherited Luxury; a dinner-only change refreshes only dinner (T-E2E-05, T-IT-REPL-01).
- AC-11-3: scenario J: Intensive -> Relaxed reduces activity density while keeping flight/hotel/confirmed-meal IDs and fixed times/durations (T-E2E-06, T-INV-04).
- AC-11-4: scenario K: the exact pending descriptor and interrupt binding reload after browser close; resume completes without duplicate effects (T-E2E-07, T-IT-INV-03).
- AC-11-5: a new request after `END` truly enters a new run at `START` with counters/scope reset and compatible state preserved (T-E2E-14, T-IT-INV-02).
- AC-11-6: SSE replay/dedupe/`Last-Event-ID` and polling fallback behave; after `202` the UI shows queued, never success, until the persisted outcome (T-E2E-10).
- AC-11-7: registry-derived graph and real highlights render with no prompts/reasoning/SQL/secrets. Faults are labeled. Revision advances once per business/decision request, not technical retry (T-INV-11).

## 10. Commands and Tests

```text
npm run typecheck
npm run lint
npm run test:unit
TEST_DATABASE_URL=... npm run test:integration
npm run build
npm run test:e2e -- --grep "phase-11|inspector|sse"
```

Tests (P11 gate): T-E2E-04/05/06/07/10/14; T-INV-04/07/11; inspector/SSE-202 checks; scenarios H/I/J/K; phase-local re-entry, preservation, and redaction tests. Never back-date tests.

## 11. Explicit Out of Scope

- Full final regression sweep, security/mobile hardening beyond this phase's checks, worker/DB restart recipes, runbook, live criterion 28: P12.

## 12. Common Mistakes / Traps

- Recomputing hashes from the whole trip; invalidating flights because dinner inventory was extended.
- Clearing reducer maps with `{}` or from a parallel worker; resetting counters on same-operation recovery.
- Automatically replaying or resubmitting a rejected modification against changed state; queuing a partial change during an active operation.
- Reusing an old approval after a route change; silently transferring bookings to a new city.
- Reading `modify`/operation identity from the browser; executing a new run while a decision is pending.
- Persisting or streaming raw graph `values`/`debug`/prompts; rendering forbidden fields in the inspector.
- SSE without authorization-before-replay, dedupe, or decimal-string cursors; JSON BigInt or lossy number conversion.
- Following a global preference change into a category downgrade for a relative cheaper search.

## 13. Completion Checklist

- [ ] Read instructions/memory; state active invariants before editing.
- [ ] Invalidation matrix, re-entry, modification admission, and preservation implemented.
- [ ] Durable SSE and inspector delivered with redaction and simulation-control gating.
- [ ] Scenarios H/I/J/K reproduced with deterministic assertions.
- [ ] Section 10 commands/tests executed with captured output; gaps reported honestly.
- [ ] Only phase-scope files changed; no commits; STOP before Phase 12.

## 14. Pasteable Executor Prompt

```text
Implement ONLY Phase 11 of the AI Travel Planner in this repository (docs/planning/phases/phase-11.md).

Analysis first (no code changes): read AGENTS.md and agent-memory/index.md, then the phase file,
docs/planning/03-langgraph-design.md (sections 3, 6, 8, 10), 04-domain-model.md (sections 2, 3, 6,
7, 9, 11), 07-conversation-and-intents.md (sections 3, 8), 08-frontend-ux.md (sections 8, 10, 11,
14, 15), 10-security-reliability.md (sections 2, 4, 8, 9) and 11-testing-strategy.md (sections
6.5, 7, 8, 14). Inspect the Phase 05 invocation/SSE, Phase 08 clarification, Phase 09 hash scope,
and Phase 10 itinerary approvals. Report the plan, affected paths, and any contract conflict.
Modify nothing in this pass.

Implementation: full invalidation-matrix dispatch (R/V/P/X/- exact; route changes rerun both
stages and need explicit impact confirmation); after-END re-entry with plain new input, serial
Overwrite counter/scope reset, preserved compatible state; pending-decision modify admission built
only by the worker; 409 OPERATION_IN_PROGRESS for changes during an active operation; hardened
durable SSE (decimal-string monotonic IDs, authorize-before-replay, Last-Event-ID/after, dedupe,
15 s heartbeat, polling fallback); graphical inspector limited to safe projected fields with
DEMO_CONTROLS_ENABLED-gated simulation controls; scenarios H/I/J/K with preservation assertions.
Binding decisions in phase-11.md section 4 are mandatory: relative cheaper preserves the bound
category; minimumActivityCounts survive summarization/refresh/restart; confirmed IDs/hashes/fixed
times unchanged by unrelated changes; null dinner only deterministic; no prompts/CoT/provider
payloads/SQL in events or inspector; a 202 never renders success; browser never executes shell
commands. Do not implement the final regression sweep, runbook, or later-phase items; do not
change contracts or add architecture; no commits.

Verify: run typecheck, lint, test:unit, test:integration (TEST_DATABASE_URL), build, and the
phase-11 E2E subset; execute the tests in phase-11.md section 10 and capture exact output; check
AC-11-1..7 and the section 13 checklist.

Report to the user in Czech: files changed, commands/results, acceptance status, incomplete work,
remaining risks, proposed memory updates only. Then STOP. Do not start Phase 12.
```
