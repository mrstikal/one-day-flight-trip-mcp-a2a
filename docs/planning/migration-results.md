# Migration results — final Phase 12 gate

Status: **complete** (2026-10-18). The target runtime is coordinator-only
(`coordinator-v1`); LangGraph is not a runtime dependency. This document records
the final regression gate, the comparable benchmark, the runtime defects the gate
found, and the evidence for the 25 success conditions in `ODFT_BRIEF.md`.

## 1. Final gate

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `npm run typecheck` | pass |
| Lint | `npm run lint` | pass |
| Unit | `npm run test:unit` | 62 files / 532 tests pass |
| Integration | `npm run test:integration` | 50 files / 275 tests pass |
| Production build + boundary verification | `npm run build` | pass (5 known Turbopack tracing warnings) |
| Browser E2E (isolated stack) | `npm run test:e2e` | 101 passed / 1 skipped |
| Comparable benchmark | `npm run benchmark:baseline` | 25/30 completed; negative route PASS |

The E2E suite runs the production `next start` build against a disposable
`*_test` database and starts the real MCP host, all specialist agents and the
coordinator worker through `tests/e2e/_services.ts`. The one skipped test is the
documented desktop-only 60-second voice cap case, skipped in the mobile project.

The final benchmark artifact is
`.cache/benchmarks/coordinator-phase12.json` (schema version 1, 30 trials plus the
negative route case). It is intentionally not committed: it contains local
database names and timing noise. The command to reproduce it is in section 7.

## 2. Comparable benchmark (six cases × five repetitions)

| Case | Phase 01 graph | Phase 12 coordinator | Total p50 / p95 (Phase 12) |
| --- | --- | --- | --- |
| `prg-rome-one-night` | 5/5 | 5/5 | 4941 ms / 5059 ms |
| `prg-rome-two-nights` | 5/5 | 5/5 | 4807 ms / 5028 ms |
| `prg-paris-one-night` | **0/5** | **0/5** | — |
| `prg-paris-two-nights` | **0/5** | **5/5** | 4874 ms / 5091 ms |
| `prg-barcelona-one-night` | 5/5 | 5/5 | 4765 ms / 4968 ms |
| `prg-barcelona-two-nights` | 5/5 | 5/5 | 4817 ms / 4919 ms |
| **Overall** | **20/30 (66.7 %)** | **25/30 (83.3 %)** | **4817 ms / 5059 ms** |
| Negative route (PRG → České Budějovice) | PASS | PASS | — |

Phase 01 baseline totals were 20/30 with p50 5215 ms / p95 5832 ms; the Phase 02
post-extraction run was 20/30 with p50 5228 ms. The coordinator therefore
completes five more deterministic trials and is slightly faster in fixture mode.
The Paris two-night improvement is a real behavior change: the coordinator's
planning loop accepts a valid draft that the retired graph rejected, and the
trial still follows the same public decision sequence
(`flight_choice → booking_confirmation → hotel_choice → booking_confirmation →
program_choices → itinerary_approval → completed`).

`prg-paris-one-night` remains a **deterministic infeasibility**, not a runtime
failure: the fixed one-night program ends at 20:00 while the simulated airport
transfer plus the 120-minute departure buffer require content to end by 19:48.
The coordinator now offers a packing clarification, then a bounded recovery
(`change_meals` / `change_hotel`), and stops at the documented three-answer
bound. The graph baseline failed the same five trials with a recovery loop; the
outcome is unchanged, but the coordinator's decision trail is explicit and every
offered option is answerable.

**Fixture AI accounting:** every trial has 0 paid LLM calls, 0 reserved/actual
tokens and 0 reserved/actual/unknown USD. Completed trials record exactly one
fixture planner and one fixture reviewer invocation. These are scripted fixture
calls, never live-model usage.

**Database activity (per-trial deltas):** completed trials commit 1121–1609
transactions (median 1471), insert 84–128 rows (median 108) and update 83–148
rows (median 127). The five failed Paris one-night trials commit 4731–4978
transactions (median 4877) because they run the bounded clarification/recovery
loop; this is the expected cost of preserving the explicit decision trail.
`pg_stat_statements` is not installed locally, so statement-level counts are not
claimed.

## 3. Runtime defects found by the final gate (fixed)

The final gate was allowed to change runtime or test code only for defects it proved.
Five defects were found and fixed:

1. **Infeasible route parked an unanswerable decision.**
   `validating_route` returned a `clarification` wait with an empty option list.
   The trip stayed `waiting_user` forever and the benchmark negative case timed
   out. It now finalizes the run as `workflow_status = 'blocked'` with the
   persisted route reasons and no pending decision
   (`packages/workflow/src/coordinator/dispatch.ts`).
2. **Invalid flight schedule parked the same unanswerable decision.** The
   Stage B failure branch now also finalizes as `blocked` with the schedule
   explanation instead of an empty-option wait. Direct regression coverage is on
   the shared blocked-finalize path in `flight-hotel-flow.test.ts`; the schedule
   branch uses the same path and Stage B itself is covered by
   `tests/unit/feasibility/schedule-stage-b.test.ts`.
3. **Generic itinerary recovery fallback was unanswerable.**
   `buildItineraryConflictDecision` returns `recoveryOptionIds` without option
   objects. The coordinator exposed `allowedOptionIds: []`, so admission rejected
   `change_meals`/`change_hotel` and the UI rendered no buttons. The fallback now
   maps `recoveryOptionIds` to allowed ids
   (`packages/workflow/src/coordinator/itinerary.ts`) and the coordinator maps
   them to their reopen actions (`packages/workflow/src/coordinator/dispatch.ts`).
4. **Test setup materialized only flights.** The shared MCP/A2A setup had been
   reduced to flight materialization, so hotel/meal/activity reads legitimately
   returned `unsupported` in 24 integration tests. The setup now extends the same
   frozen snapshot with all research domains and revalidates Stage B
   (`tests/integration/mcp/_setup.ts`).
5. **An immediate manual voice stop reported a generic failure.** A
   container-only recording could not be decoded and surfaced "The voice request
   failed" instead of the no-speech copy. The capture controller now maps decoder
   errors (`EncodingError`/`NotSupportedError`) to `VOICE_COPY.noSpeech`
   (`apps/web/src/lib/voice-capture.ts`), with a unit test.

Two E2E fixture defects were also fixed: the inspector spec read a non-existent
`id` field from the trip-creation response (the contract returns `tripId`), and
its directly inserted observation payload omitted required nullable fields.

The benchmark harness itself was corrected: it used to start only the web server
and worker, which cannot exercise A2A/MCP delegation. It now owns the complete
fixture stack (MCP host, three primary agents, coordinator worker, production
web server) and drives `agent_input` and `clarification` finite-option decisions
in addition to the original policy. Its clarification policy never selects a
budget-raising option, so a trial cannot buy completion by silently changing the
traveler's budget; a budget-only clarification is recorded as
`clarification_budget_only` and fails the trial.

Review hardening: `tests/e2e/_services.ts` now rejects any E2E/benchmark
database whose name does not end in `_test` (including the `resetRateLimits`
path that runs before the stack starts), with unit coverage in
`tests/unit/e2e-database-guard.test.ts`. The retired-runtime planning documents
`00`, `01`, `02`, `03` and `12` are explicitly labeled historical so they cannot
be mistaken for the active architecture.

## 4. Scenarios A–L against the final build

| Scenario | Evidence (all re-run in the final gate) |
| --- | --- |
| A — Agent discovery | `tests/integration/a2a/*.test.ts`, `coordinator/admission.test.ts`; inspector E2E renders discovered cards. |
| B — Independent delegation | `tests/integration/a2a/{flight,accommodation,city-guide}.test.ts`; real HTTP tasks and validated v1 artifacts. |
| C — MCP discovery | `tests/integration/mcp/*.test.ts`; official client discovery/invocation and safe telemetry. |
| D — Parallel execution | `tests/integration/a2a/parallel-research.test.ts`; overlapping execution windows and persisted aggregation. |
| E — Additional information | `tests/integration/a2a/{input-required,accommodation-alt}.test.ts`; queue-before-drain and same-task continuations; `protocols/restart.test.ts`. |
| F — Streaming | `tests/integration/protocols/sdk-interoperability.test.ts`, `tests/e2e/sse-replay.spec.ts`; real status events and deduped replay. |
| G — Agent failure | `tests/integration/protocols/failure-recovery.test.ts`; explicit `AGENT_RESTARTED`, preserved hotel, scoped City Guide retry. |
| H — MCP failure | `tests/integration/protocols/failure-recovery.test.ts`; host outage, timeout and fresh-task recovery. |
| I — Hotel re-planning | `tests/integration/coordinator/itinerary.test.ts`, `tests/e2e/phase-07.spec.ts`; hotel-only refresh and confirmation. |
| J — Agent replacement | `tests/integration/protocols/agent-replacement.test.ts`, `tests/e2e/agent-replacement.spec.ts`; registry-only switch, old binding retained. |
| K — Restart recovery | `tests/integration/protocols/restart.test.ts`, `failure-recovery.test.ts`, `coordinator/recovery.test.ts`; canonical task reuse, commit-before-cursor replay (confirm and decline), owner retry. |
| L — Booking safety | `tests/integration/coordinator/flight-hotel-flow.test.ts`, `tests/integration/coordinator/recovery.test.ts`, `tests/integration/coordinator/cancellation.test.ts`, `tests/e2e/phase-07.spec.ts`; `DEMO-*` references, explicit consent, one confirmed service, idempotent replay. |

## 5. The 25 success conditions

| # | Condition | Evidence |
| --- | --- | --- |
| 1 | Existing planner remains functional | Full unit/integration/E2E gate; benchmark completes 25/30 deterministic trials. |
| 2 | Frontend recognizably the same | Same wizard, rail, inspector and history routes; E2E covers desktop and mobile. |
| 3 | European destination support preserved | Offline GeoNames/OurAirports assets; Rome, Paris and Barcelona benchmark cases plus generic-city coverage. |
| 4 | Synthetic data deterministic and coherent | Six distinct derived seeds, `generator-v1`, `reference-2026-10-10`; identical seeds/fingerprints across trials. |
| 5 | Travel Variant, Service Level, Activity Pace preserved | Variant cases in the benchmark; service-level and pace tests in `coordinator/itinerary.test.ts` and `e2e/phase-07.spec.ts`. |
| 6 | Flight feasibility correct | Stage A/B route and schedule tests; negative route case PASS. |
| 7 | Simulated bookings work | `coordinator/flight-hotel-flow.test.ts`, `coordinator/recovery.test.ts`, `coordinator/cancellation.test.ts`; one `DEMO-*` reservation per service, idempotent replay. |
| 8 | Natural-language modifications work | `coordinator/decisions.test.ts`, `itinerary.test.ts` chat/pace/route-change tests; E2E chat flows. |
| 9 | LangGraph no longer a runtime dependency | Build verification rejects LangGraph/checkpointer imports; no graph worker starts. |
| 10 | Multiple independent A2A agents operational | Flight, Accommodation, Accommodation B and City Guide processes; integration/E2E start them separately. |
| 11 | Agent Cards discoverable | Card discovery tests and inspector rendering; pinned origin/URL/timeout. |
| 12 | A2A tasks and structured artifacts used correctly | `sdk-interoperability`, artifact validation, admission/replay and continuation suites. |
| 13 | At least two agents invoke MCP tools | Flight/Accommodation/City Guide MCP scopes and integration tests. |
| 14 | Multiple MCP services/capabilities | Three endpoints (`geography`, `travel-data`, `itinerary-tools`) with distinct tool/resource sets. |
| 15 | Parallel agent execution | `parallel-research.test.ts`; concurrent accommodation/city-guide tasks and overlapping execution windows. |
| 16 | Input-required interactions | `input-required.test.ts`, `accommodation-alt.test.ts`, coordinator question queue. |
| 17 | Task progress streamed to the frontend | SSE replay tests and inspector live updates; polling fallback. |
| 18 | State survives coordinator restart | `protocols/restart.test.ts`, `coordinator/recovery.test.ts`; lease reclaim and saved cursor. |
| 19 | Agent failures do not corrupt trip state | `failure-recovery.test.ts`; terminal failures, preserved siblings, explicit retry. |
| 20 | Selective re-planning preserves selections | `coordinator/itinerary.test.ts`; unaffected artifacts/selections/reservations retained. |
| 21 | One specialist replaceable | `agent-replacement.test.ts`, `e2e/agent-replacement.spec.ts`; registry-only switch. |
| 22 | Inspector distinguishes A2A and MCP | `agent-communication.spec.ts`; distinct edges and tables for real persisted rows. |
| 23 | LLM usage/cost observable | Inspector AI telemetry and `llm_usage` ledger; fixture trials record zero billable usage. |
| 24 | No real reservations/payments | `DEMO-*` references only; disclaimer required; no payment code. |
| 25 | Automated tests and demos pass | Final gate above: typecheck, lint, 532 unit, 275 integration, build verification, 101 E2E, 30-trial benchmark. |

## 6. Architecture review conclusions

- The runtime has no fake protocol wrapper: A2A uses the official SDK over real
  HTTP, MCP uses official clients/servers with modern negotiation, and every
  observation is persisted by the real transport path.
- Business rules are not duplicated in agents: agents rank/read delegated
  candidates; the coordinator owns feasibility, selection, booking, itinerary
  assembly, validation, review policy and publication.
- The coordinator is a small explicit state machine, not a general workflow
  engine; there is no second orchestration framework.
- LLM spending is bounded per role, task and trip, and the fixture mode makes the
  deterministic gate free. Live OpenRouter behavior remains measured by the
  existing telemetry, not by this fixture benchmark.
- Discovery is trusted-registry-only with pinned origins, and agent database
  roles are least-privilege; read-only MCP roles are write-denial tested.
- Recovery claims are backed by executable kill-point tests, not assertions.

## 7. Reproduction

```bash
# Full gate
npm run typecheck && npm run lint
npm run test:unit
npm run test:integration          # TEST_DATABASE_URL must end in _test
npm run build
npm run test:e2e                  # DATABASE_URL/PUBLIC_BASE_URL on an isolated stack

# Comparable benchmark (owns a disposable *_test database and ports 3100/44xx)
DATABASE_URL=postgres://.../odft_phase12_test \
PUBLIC_BASE_URL=http://localhost:3100/ \
npm run benchmark:baseline -- --output .cache/benchmarks/coordinator-phase12.json
```

## 8. Limitations and expected differences

- Fixture AI mode is deterministic and free; it does not measure live-model
  latency, token usage or ranking quality. The Phase 01/02 baseline was also
  fixture-only, so the comparison is like-for-like.
- Latency includes public HTTP polling at 250 ms, one worker, one web server and
  the real multi-process A2A/MCP stack. It is not a production load test.
- `pg_stat_statements` is unavailable locally; database activity is reported as
  coarse `pg_stat_*` deltas that include the harness's own measurement queries.
- Paris one-night is a fixed-input infeasibility. The coordinator surfaces a
  bounded clarification/recovery trail instead of silently changing the plan.
- Historical planning documents for the retired graph remain in
  `docs/planning/` for context; the active runtime is described by this document
  and `docs/architecture/coordinator.md`.
