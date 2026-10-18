> **Historical planning material.** This document describes the retired LangGraph runtime and is kept for context only. The active architecture is `docs/architecture/coordinator.md`; the final gate is `docs/planning/migration-results.md`. LangGraph/checkpointer commands and test IDs below are historical and are not part of the active runtime.

# Phase 07 analysis — durable application coordinator

Status: produced before implementation (plan Phase 07 requires an approved
transition table, transaction boundaries and recovery behavior first). The
implementation follows this document; deviations are noted in the final report.

## 1. Scope and non-goals

Deliver an isolated coordinator engine that drives complete flight/hotel/program
workflows for coordinator trips through genuine specialist delegation, while the
existing LangGraph path stays the production default and is untouched. No final
LangGraph removal, no generic scheduler, no new public coordinator HTTP port, no
full itinerary loop, no frontend redesign, no legacy runtime.

Implementation notes (post-review): the engine seam for NEW trips is the
server-controlled `createTrip({ engine })` option (not an env flag); the
`validating_logistics` and `progress.ts` items of the module list were folded
into the booking/program stage of `dispatch.ts`; `decisions.ts`/`reconcile.ts`
helpers live in `dispatch.ts`/`delegations.ts`; free-text operations fail
safely (`COORDINATOR_UNSUPPORTED_OPERATION`) until Phase 08 parity; program
submission (`submit_program`) is not yet implemented in the coordinator.

## 2. Engine discrimination and dispatch

- `trips.engine` (`langgraph` | `coordinator-v1`) is the single source of truth;
  operations/decisions/checkpoints stay engine-tagged (Phase 03 storage).
- **Claim filter (new):** the claim query joins the trip and takes an explicit
  supported-engine set, so the graph worker claims only `langgraph` operations
  and the coordinator driver only `coordinator-v1`; a coordinator operation can
  never reach `apps/worker/src/driver.ts` and vice versa.
- `apps/worker/src/main.ts` starts one claim loop per supported engine with the
  matching driver (same process is acceptable; concurrency stays two, leases
  60 s, renewal 15 s, per-trip locking, three automatic claims per round).
- Trip creation: a server-controlled test configuration (`ODFT_TRIP_ENGINE`
  default `langgraph`) selects the engine for **new** trips; `trips.engine` is
  immutable afterwards. Existing trips and the default web flow are unchanged.

## 3. Transition table (`packages/workflow/src/coordinator/state.ts`)

Each row lists step → (trigger) → next step, the persisted run data written in
the same fenced transaction, and the wait reason when it parks. The cursor is
`(step, waitReason, runData)`; `state_version` bumps on every write.

| From | Trigger | To | Transaction payload / notes |
| --- | --- | --- | --- |
| — | operation claimed (creation) | `interpreting` | insert run row (revision bound) |
| `interpreting` | intent parsed (reuse the graph-free intent path) | `validating_route` | — |
| `validating_route` | Stage A feasible + snapshot materialized | `requesting_flights` | snapshot id + fingerprints into runData |
| `validating_route` | INFEASIBLE / GROUND_TRAVEL_PREFERRED | `awaiting_user(route_change_confirmation\|clarification)` | decision row (engine-tagged) |
| `requesting_flights` | flight delegation dispatched (outbound row persisted first) | `researching` | delegationIds += flight |
| `researching` | flight task terminal + artifact accepted | `validating_logistics` | acceptedArtifacts.flights; Stage B; **hotel delegation + city research dispatched concurrently** |
| `researching` | hotel/city task `input_required` observed | `awaiting_user(agent_input)` after **drain** | questionQueue (FIFO), drainPending |
| `researching` | all necessary domains usable | `planning` | acceptedArtifacts for each domain |
| `researching` | a necessary domain failed (retry classification) | `awaiting_user(clarification)` or retry within cap | partial-result policy |
| `planning` | itinerary materialized | `awaiting_user(program_choices\|hotel_choice)` | decision row + waiting run/operation state atomically |
| `awaiting_user(*)` | accepted decision (unchanged revision) | target step from the decision kind | decision response admitted with the SAME revision; delegation queue/cursor transferred where applicable |
| any | unrecoverable failure | `failed` (+ operation failed) | failureCode; no retry loop |
| any | cancellation accepted | `cancelled` | fenced |

Lock order stays §3.8: trip → operation → decision/delegation → counters;
network calls are NEVER inside a transaction or effect.

## 4. Transaction boundaries

- **One short fenced transaction per transition**: lock the trip row, verify
  fence + accepted revision + operation status, write the run cursor/step/
  waitReason, the operation status/outcome, and (when parking) the pending
  decision row together, then commit. `pool.query` outside that block performs
  no writes.
- **Outbound delegation**: `agent_delegations` + `protocol_outbound_messages`
  rows commit BEFORE any HTTP delivery ("persist before deliver"); delivery
  outcome (delivered/acknowledged/failed) is a separate short transaction.
- **Artifact ingestion**: accept an artifact in a short transaction that
  validates delegation/task/revision/snapshot/input scope, dedupes by payload
  hash, and stores the artifact reference in run data — never the payload.
- **Question observation**: persist the observed question (FIFO append + drain
  flag) under the ORIGINAL lease/fence before draining siblings.
- **Decision admission**: the answer is admitted with the trip revision
  UNCHANGED; the decision row is consumed and the run cursor promoted in one
  fenced transaction. Only the answering task's delegation is rebound; an
  unrelated working sibling is never touched.
- **Booking**: `BookingService` (effects + commit-before-cursor replay) is
  called only after the accepted booking/decline response, exactly like the
  graph path; replay after a crash re-reads the effect ledger before the cursor.

## 5. Recovery behavior

- Startup reconciliation for coordinator runs: `running` operations with an
  expired lease are re-claimed by the next claim round (existing lease rules);
  a `waiting` run is only touched by an accepted decision.
- **Saved tasks on restart**: before any new dispatch, the driver re-reads
  outbound rows and re-`tasks/get`s dispatched delegations, ingesting artifacts
  idempotently (payload-hash dedupe) and rejecting stale fence/revision/
  snapshot/input scope.
- **Commit-before-cursor**: booking effects recorded in the effect ledger are
  replayed before the run cursor advances, so a crash between effect and cursor
  cannot double-book.
- **Lost acknowledgements**: a dispatched-but-unacknowledged delegation is
  re-delivered at most once per task (canonical admission on the agent side
  dedupes by message id), never re-executing paid work.
- **Drain/promotion crash**: `drainPending` + questionQueue in run data make
  the drain resumable; promotion rebinds only the answering task and transfers
  the remaining queue atomically.
- All network calls remain outside effects/DB transactions.

## 6. Drain-before-decision handoff and queue promotion (§3.10)

1. A specialist question observed while siblings are in flight is persisted in
   the FIFO queue (`observedAt` order) and `drainPending = true`; NO answerable
   decision is exposed yet.
2. The driver waits for the in-flight siblings to reach a terminal state (or
   the bounded remaining task duration), ingesting their artifacts; then it
   promotes exactly ONE validated FIFO question as the `agent_input` decision.
3. The answer (`choose_option`) is admitted at the UNCHANGED trip revision; the
   answering delegation/task is rebound with the new input generation while the
   remaining queue/cursor transfers to the next operation.
4. At most two questions per task and four queued questions (contract caps);
   second-input and failed/timed-out siblings are covered by tests.

## 7. Modules and tests

- `packages/workflow/src/coordinator/{state,dispatch,decisions,delegations,reconcile,progress}.ts`
  and `apps/worker/src/coordinator-driver.ts`; adapt the worker claim/main and
  the web trips route for the server-controlled engine flag.
- Tests: `tests/integration/coordinator/{admission,flight-hotel-flow,decisions,input-required,parallel-research,recovery}.test.ts`
  plus the existing booking/domain suites, a graph compatibility smoke,
  typecheck/lint/build.
- `docs/architecture/coordinator.md` documents the transition/ownership model
  exactly as implemented.

## 8. Risks and mitigations

- **Dual-engine dispatch**: explicit engine sets in claims + a boot assertion
  that neither driver sees the other's engine.
- **Inconsistent decision/cursor commits**: every transition writes decision +
  cursor + operation in ONE fenced transaction.
- **Holding connections across waits**: no network call inside transactions.
- **Incorrect rebinding**: only the answering task's delegation is rebound; the
  task/delegation binding is validated by the existing `consumeInputContinuation`
  semantics on the agent side and by the run-data queue on the coordinator side.
- **Booking duplication**: effect-ledger replay before cursor advance.
- **Drain gate latency**: bounded by the remaining task duration/lease; the
  initial independent research is never serialized.
