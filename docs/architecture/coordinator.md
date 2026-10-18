# Durable coordinator runtime (Phase 12)

The coordinator is the **only** application runtime for new trips. LangGraph and
its checkpointer are not runtime dependencies; the graph worker, graph state and
graph decision bindings were removed in Phase 11. Historical rows written by the
retired graph remain readable as inert history, but no new graph work can be
claimed or started.

## Runtime ownership

| Concern | Owner |
| --- | --- |
| HTTP BFF, session/CSRF, projections, SSE | `apps/web` (Next.js) |
| Durable operation execution | `apps/worker` (`coordinator-v1`) |
| MCP reference/scenario/itinerary tools | `apps/mcp-server` |
| Specialist research/planning | `apps/flight-agent`, `apps/accommodation-agent`, `apps/accommodation-agent-alt`, `apps/city-guide-agent` |
| Domain truth, operations, decisions, events, protocol evidence | PostgreSQL |

`trips.engine` is `coordinator-v1` for every new trip and is immutable.
`workflow_operations` and `pending_decisions` carry the same engine; the claim
filter joins `trips.engine`, so a coordinator worker cannot claim legacy work.
The worker exposes no public HTTP port; it connects to PostgreSQL and writes a
heartbeat every 10 seconds.

## Process topology (development defaults)

| Process | Default address | Notes |
| --- | --- | --- |
| Web | `http://127.0.0.1:3000` | Production E2E uses `next start` on port 3100 |
| MCP host | `127.0.0.1:4321-4323` | `/geography/mcp`, `/travel-data/mcp`, `/itinerary-tools/mcp` |
| Flight agent | `127.0.0.1:4401` | `flight.recommend.v1` |
| Accommodation agent | `127.0.0.1:4402` | `accommodation.recommend.v1` |
| City Guide agent | `127.0.0.1:4403` | `city-guide.research.v1`, `itinerary.propose.v1` |
| Accommodation agent B | `127.0.0.1:4404` | Same skill, independent implementation |
| Coordinator worker | no public port | Claims queued operations and writes the heartbeat |

The trusted agent registry is the only discovery source. Each agent receives its
own restricted database role and MCP token; the MCP host reads the inbound agent
identity from the bearer token, never from a request body.

## Cursor and transitions

- One active `coordinator_runs` row per trip stores
  `(step, wait_reason, runData)`; `state_version` increments on every write.
- `packages/workflow/src/coordinator/state.ts` defines the transition algebra:
  `continue`, `wait`, `complete`, `fail`, `abandon`.
- Steps: `initializing → interpreting → validating_route → requesting_flights →
  researching → planning → awaiting_user`; terminal run states are `completed`
  and `failed`. A decision resume re-enters at `interpreting` with the same cursor
  row and a new operation id.
- `dispatch.ts` owns the step handlers and a bounded transition budget per claim
  (12 transitions). A `wait` parks the operation with a pending decision; an
  `abandon` leaves the operation `running` without finalizing, so the lease
  expires and the next claim resumes the saved cursor.
- A completed route rejection or schedule rejection is a **blocked** outcome
  (`workflow_status = 'blocked'`), not an empty pending decision. The persisted
  route/schedule validation carries the safe reasons for the UI.
- An itinerary conflict exposes only finite options. A clarification carries its
  explicit options; the generic recovery fallback exposes its
  `recoveryOptionIds` (`change_hotel`/`change_meals`) and maps them to the step
  that can actually free the conflict.

## Transaction boundaries

- Every state change is one short fenced transaction. `continue` cursor writes
  are refused when the claim no longer holds the operation's fencing token.
- `finalizeWaiting`, `finalizeSuccess` and `finalizeFailure` accept
  `extraWrites`, so the run cursor, operation status, pending decision, assistant
  message and protocol evidence commit together.
- Outbound delegation commits **before** delivery: `agent_delegations` +
  `protocol_outbound_messages` (payload, hash, message id) are written first;
  delivery outcomes are short follow-ups. Re-delivery reuses the persisted
  message id, so specialist admission replays the canonical task instead of
  executing twice.
- Artifact ingestion validates the delegation binding (delegation, trip,
  snapshot, operation, revision) and stores only a reference
  (`accepted_artifact_hash`); payloads never enter run data.
- Booking uses the same `BookingService` as the rest of the application. The
  confirmation carries a stable `confirmationKey`; a replayed confirmation is
  resolved through effect idempotency, so a crash after the booking commit cannot
  create a second reservation.
- Network calls (delivery, task reads, MCP calls) never run inside a
  transaction.

## Research delegation and MCP

- The coordinator evaluates Stage A and materializes flights before delegating;
  the Flight agent ranks only schedule-valid combinations of the delegated frozen
  snapshot.
- Hotel/meal/activity/event research is delegated concurrently to the
  Accommodation and City Guide agents. Each agent reads its authorized domains
  from the MCP host with the delegation id and exact snapshot id; the active trip
  pointer is never read by an agent or MCP tool.
- A specialist `input_required` task is queued (binding only) and does not block
  working siblings. When every submitted sibling is terminal, exactly one
  validated FIFO question is promoted as an `agent_input` decision at the
  unchanged trip revision. The answer is persisted as a new outbound
  continuation for the answering task only.
- An unavailable necessary domain opens a typed recovery decision; a completed
  sibling artifact is retained. A flight failure blocks because no flight choice
  can be offered.

## Planning loop

- The City Guide agent proposes a planner-compatible day; the coordinator
  reassembles, validates and reviews it locally. Candidate membership is checked
  against the locally loaded planning data, so an invented id is rejected before
  any draft is stored.
- The loop is bounded to three application attempts. Invalid drafts and
  `revise` reviews become feedback for the next attempt; at the bound the run
  opens the existing conflict decision or the approval park. The agent cannot
  start an internal loop.
- Typed commands are applied in one deterministic batch. Only affected domains
  are re-delegated; unaffected artifacts, selections and confirmed reservations
  are retained.
- Approving the persisted draft is separate from booking; a stale or superseded
  itinerary is refused.

## Decisions, cancellation and budget

- Pending decisions are engine-bound rows with a fingerprint over the relevant
  state. Admission checks the decision id, offered ids, expected revision and
  request id; a stale decision is refused instead of applied.
- Cancellation rotates the fence, revokes outstanding delegations and persists a
  remote-cancel intent in one commit. Late artifacts are inadmissible and a
  terminal task is never resurrected.
- LLM calls are reserved before sending and settled after the response; unknown
  outcomes keep counting against task and trip caps. The per-trip limits are
  `MAX_LLM_CALLS_PER_TRIP` and `MAX_LLM_COST_USD_PER_TRIP`. Fixture mode writes
  no billable ledger rows.

## Recovery

- Startup claims are lease-based; a crashed operation is reclaimed after its
  lease expires and resumes from the persisted cursor.
- Research steps re-read dispatched delegations and `getTask` the saved task;
  artifacts are ingested idempotently and stale scopes are rejected.
- An unacknowledged outbound intent is re-delivered from the persisted payload
  with the same message identity.
- A specialist that dies mid-work is reconciled to an explicit
  `AGENT_RESTARTED` failure; interrupted computation is never fabricated as a
  success. `input_required` is a resting state and survives restarts.
- An owner retry of a terminally failed run reopens the same run at
  `interpreting`, reuses completed accepted siblings and re-dispatches only the
  failed scope.

## History

- `/trips/[id]/history` renders persisted operation, decision and protocol
  evidence for the owning session; archived trips are read-only.
- Legacy graph history, when present, is rendered read-only and is never used to
  resume work.
- The inspector (`/trips/[id]/inspector`) shows the A2A/MCP/application timeline,
  operation attempts, AI telemetry and labeled simulated faults without exposing
  prompts, raw payloads or secrets.

## Evidence

- `tests/integration/coordinator/*` — cursor, admission, decisions, itinerary,
  recovery, cancellation, history authorization.
- `tests/integration/protocols/*` — restart, outage, cancellation and
  replacement races over real HTTP.
- `tests/e2e/*` — production build, SSE replay, inspector, protocol failures,
  history and mobile/desktop wizard flows.
- `docs/planning/migration-results.md` — final gate and benchmark comparison.
