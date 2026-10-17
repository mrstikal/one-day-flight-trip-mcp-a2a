# Durable application coordinator (Phase 07)

The coordinator is a second, independent execution engine for new trips. It
coexists with LangGraph: the default application stays graph-backed, existing
trips never change engine, and the two engines cannot claim each other's work.

## Engine ownership

- `trips.engine` (`langgraph` | `coordinator-v1`) is immutable and is the single
  source of truth; operations and pending decisions carry the same engine.
- Claims are engine-filtered (`ClaimOptions.engines` joins `trips.engine`): the
  graph worker loop claims only `langgraph`, the coordinator driver only
  `coordinator-v1` (`apps/worker/src/worker.ts`, `ODFT_COORDINATOR=1` starts the
  second loop; every offline test drives `runCoordinatorOperation` directly).
- New coordinator trips exist only through the server-controlled seam:
  `createTrip({ engine: "coordinator-v1" })` (fixture/test configuration). The
  production web default (no option) stays `langgraph`.
- Graph decisions keep `thread_id`/`graph_version`; coordinator decisions carry
  `coordinator_run_id` and NULL graph ids (schema constraint from 0013).

## Cursor and transitions

- One active `coordinator_runs` row per trip stores the cursor:
  `(step, wait_reason, runData)`; `state_version` bumps on every write.
- `packages/workflow/src/coordinator/state.ts` defines the transition algebra
  (`continue` / `wait` / `complete` / `fail` / `abandon`); `dispatch.ts` owns the
  handlers and the loop (max 12 transitions per claim).
- Steps: `initializing → interpreting → validating_route → requesting_flights →
  researching → planning → awaiting_user` (parks), with `completed`/`failed`
  terminal. A decision resume re-enters at `interpreting` with the same cursor
  row and a new operation id.
- `abandon` leaves the operation `running` without finalizing: the lease expires
  and the next claim resumes the same step from the saved cursor (saved-task
  recovery). Delivery attempts are bounded and idempotent.

## Transaction boundaries

- Every state change is one SHORT fenced transaction (`continue` cursor writes
  are refused when the claim no longer holds the operation's fencing token):
  `finalizeWaiting` /
  `finalizeSuccess` / `finalizeFailure` accept `extraWrites`, so the run cursor
  is committed together with the operation status and the pending decision
  (`finalizeWaiting` writes the engine-bound decision row in the same block).
- Outbound delegation commits BEFORE delivery ("persist before deliver"):
  `agent_delegations` + `protocol_outbound_messages` (payload + hash + message
  id) are written first; delivery outcomes are short follow-ups. A re-delivery
  reuses the persisted message id, so the specialist's admission replays the
  canonical task instead of executing twice.
- Artifact ingestion validates the delegation binding (delegation/trip/
  snapshot/operation/revision) and stores only a reference (`accepted_artifact_hash`
  on the delegation row, payload hash as the decision fingerprint) — payloads
  never enter the run data.
- Booking goes through the SAME `BookingService` as the graph after the accepted
  response; the confirmation carries a stable `confirmationKey` and a replayed
  confirmation (proposal already `accepted`/`rejected`) is admitted again and
  resolved through the service's effect idempotency (commit-before-cursor).
- Network calls (delivery, task reads) NEVER run inside a transaction.

## Drain-before-decision and the question queue

- A specialist task in `input_required` is recorded in the run data's FIFO
  `questionQueue` (binding only; text/options are re-read from the saved task at
  promotion) and does NOT block the drain — working siblings keep polling. The
  queue is persisted with every parked cursor and every abandon, so a question
  observed during a choice park or a crash is never lost.
- Only when every submitted sibling is terminal does the coordinator promote
  exactly ONE validated FIFO question (shifted from the queue) as an
  `agent_input` decision (`AgentInputDecisionPayload`) at the UNCHANGED trip
  revision, and always BEFORE parking a choice.
- The accepted `choose_option` answer is persisted as a new outbound
  continuation (question `inputGeneration + 1`) and delivered to the ANSWERING
  task only; unrelated siblings are never touched. The agent consumes the answer
  exactly once, the coordinator ingests the continuation artifact under the
  delegation binding, and the remaining queue continues in the run data.

## Recovery

- Startup: claims are lease-based; a crashed operation is re-claimed after its
  lease expires and resumes from the persisted cursor.
- Saved tasks: a research step re-reads dispatched delegations and re-`getTask`s
  them; artifacts are ingested idempotently and stale scopes are rejected.
- Lost acknowledgements: an unacknowledged outbound intent is re-delivered from
  the persisted payload (same message identity) — verified by tests.
- The isolated integration suites are `tests/integration/coordinator/*`; the
  engine-dispatch proof walks `admission.test.ts` (a coordinator operation is
  invisible to the `langgraph` claim filter).
