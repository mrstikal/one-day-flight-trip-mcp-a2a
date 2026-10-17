# Phase 05 analysis — Flight A2A service and delegated governance

Analysis pass of the two-pass workflow (ODTF_PLAN.md §4). **No code was changed
for this document.** It proposes the exact implementation and validation
approach and requests approval before the implementation pass. Per the phase
dependencies it reviews (a) crash boundaries and delegated authorization and
(b) the complete shared transaction/lock graph from §3.8, including retained
graph adapters and the checkpoint gate.

## 1. Scope

Deliver the first independently executable specialist: a Flight Agent process
using genuine A2A tasks, real MCP reads (Phase 04 endpoints), the existing
governed AI abstraction with a NEW delegated (non-fenced) authority, durable
message admission, cumulative task limits and shared per-trip budget caps.
Out of scope: coordinator switch, accommodation/city-guide agents, itinerary,
legacy removal.

## 2. Verified current state (source inspection)

### 2.1 Shared lock graph today (§3.8 audit)

| Path | Current locks (in order) | Verdict |
| --- | --- | --- |
| `operations/control.ts` (`retry/cancel control`) | `lockTrip` → operation update | compliant (trip → operation) |
| `llm-calls.ts` `reserveCall` | `BEGIN` → `SELECT trips … FOR UPDATE` → ledger insert/update | compliant (trip → ledger) |
| `booking-store.ts` (BookingService) | `lockTrip` → proposal/reservation writes | compliant (trip first) |
| `operations/claim.ts` claim/renew | operation-only (`FOR UPDATE SKIP LOCKED`) | allowed (never takes a trip lock afterwards) |
| `operations/fencing.ts` checkpoint gate | `pg_advisory_xact_lock` after caller's app locks; saver-side guard reads ownership WITHOUT `FOR UPDATE` | compliant with §3.8's gate rule |
| **`operations/finalize.ts` `finalizeWaiting`/`finalizeSuccess`** | **`UPDATE workflow_operations` (operation row lock) → `UPDATE trips`** | **VIOLATION: operation → trip** |
| **`operations/claim.ts` `reapExhaustedOperations`** | **batch `FOR UPDATE SKIP LOCKED` on operations → `UPDATE trips` per row** | **VIOLATION: operation batch → trip** |

Both violations are exactly the "existing operation-before-trip
finalizers/reapers" §3.8 orders fixed before delegated reservations can be
enabled. ABBA is reachable today: control path (trip → operation) vs finalize
path (operation → trip).

### 2.2 AI surface

- `recommendationContextSchema` (`packages/ai/src/context/role-contexts.ts`)
  targets `hotel | breakfast | lunch | dinner | activities`; candidates carry
  hotel/meal/activity facts only — **no flight candidates**.
- Prompt `recommendation-v1` + `recommendationRole` + `RECOMMENDATION_LIMITS`
  (20 s, 2 attempts, 0.05 USD/call) exist; `fixture-adapter.ts` handles the
  `recommendation` role deterministically.
- `packages/services/src/ai/authority.ts` currently defines ONLY
  `OperationAuthority` (kind `"operation"`, coordinator fencing token). The
  worker AI path (`ai/runtime.ts`) is fenced and must not be copied as an
  agent privilege.
- `llm-calls.ts` ledger: reservation/settlement/unknown semantics + per-trip
  caps (`maxLlmCallsPerTrip`, `maxLlmCostUsdPerTrip`) already enforced inside
  `reserveCall` under the trip row lock.

### 2.3 Protocol surface (Phase 03/04)

- `@odft/protocols` already provides: trusted registry + exact-origin client,
  durable admission (claim → canonical task → mapping → control row, replay/
  conflict), `ServiceInstanceLock`, task-control helpers
  (`upsertTaskControl`, `addTaskCounters`, `setTaskState`, `markRestartedTasksFailed`,
  `saveValidatedOutput`), sanitized observations, and the modern-only server
  mount. Phase 04 MCP tools return frozen-snapshot facts and Stage-B-valid
  flights with the flights domain hash.
- `agent_delegations` (0013) carries identity/skill/snapshot/scope/status/
  deadline; `delegationScopeSchema` (Phase 04) is the persisted authority
  shape.

## 3. Approved lock graph (proposed, §3.8)

All application-row-lock transactions use
**trip → operation → delegation → task counters/usage ledger**, multiple rows
of one level in stable ID order; a transaction may skip levels but never
acquire an earlier level later.

Concrete changes (implementation pass):

1. **`finalizeWaiting`/`finalizeSuccess`/`finalizeFailure`** (and the blocked
   path): take the trip row lock FIRST (`SELECT … FROM trips WHERE id = $1 FOR
   UPDATE`, i.e. reuse `lockTrip`), then transition the operation by fence.
   Ordering change only; the fence check, decision insert/retire, event and
   result payload stay byte-identical. On a stale fence the transaction rolls
   back (already the behavior).
2. **`reapExhaustedOperations`**: iterate candidates, and for each row lock
   `trips` first, then the operation (`FOR UPDATE`), re-checking
   `status='running' AND auto_claims >= max AND lease_expires_at < now()` after
   both locks; skip rows that no longer qualify. No batch operation locks.
3. **New delegated paths** acquire: `trips FOR UPDATE` (only inside
   `reserveCall`'s existing transaction — reused unchanged) → delegation row
   (`agent_delegations … FOR UPDATE` where a counter/status update needs it) →
   `protocol_task_control` counters. No agent path ever takes an operation row
   lock (agents have no operation authority).
4. **Retained graph adapters**: worker `runEffect` keeps its short transaction;
   the driver continues to rotate tokens under the checkpoint gate AFTER its
   application row locks (unchanged); the fenced saver keeps its separate
   non-locking ownership read. No network call inside any transaction.
5. **Phase 09 cancellation** will reuse the same order (trip → operation →
   delegation → counters) — documented now, implemented later.

Verification: a dedicated concurrency test (`transaction-locking.test.ts`)
drives concurrent reserve/finalize/control/reap interleavings on constrained
pools and asserts no `40P01`, no cross-connection self-blocking and no false
paid-transport retry.

## 4. Delegated authorization (proposed)

New tagged authority in `packages/services/src/ai/authority.ts`:

```ts
interface DelegatedAuthority {
  kind: "delegation";
  delegationId: string; agentIdentity: string; skillId: string;
  tripId: string; snapshotId: string; acceptedRevision: number;
  domains: DelegationDomain[]; inputGeneration: number;
}
```

- `validateDelegatedAuthority(pool, authority, required)` re-reads the
  delegation row (status not revoked/cancelled/failed, deadline, snapshot,
  domain) and rejects a mismatch. Agents receive NO coordinator fencing token;
  the authority is a lookup key, never a bearer secret.
- AI runtime gains a delegated entry (`interpret`-style) that reserves through
  the SAME `reserveCall` (trip lock first) with agent/delegation/task/trace
  correlation, `maxAttemptsPerScope` per attempt, unknown-charge retention and
  shared trip caps. Per-attempt reservation; no budget reset on continuation.
- Task limits (§3.9 table): 60 s active / 4 MCP invocations / 2 LLM attempts /
  USD 0.10 for `flight.recommend.v1`, enforced from
  `protocol_task_control` counters (`active_time_ms`, `mcp_invocations`,
  `llm_attempts`, reserved/actual USD) in short transactions; a continuation
  gets only the remainder.

## 5. Implementation plan (exact files)

### 5.1 `apps/flight-agent` (new)

`package.json`, `tsconfig.json`, `src/{main,app,config,card,executor}.ts`:
trusted loopback binding, bearer auth (registry), modern-only `/a2a` mount via
`mountA2AServer`, per-agent task table (`odft_protocol.agent_tasks_flight`),
single-instance `ServiceInstanceLock`, startup reconciliation
(`reconcileRestartedTasks`), executor implementing the §3.9 lifecycle with real
`McpClient` reads (`search_flights` with the coordinator-supplied approval
context + `get_scenario_metadata`), deterministic initial ranking (reuse the
research ranking helper), optional governed reorder via the recommendation role
(v2, permutation/subset validation, safe fallback to the deterministic order),
progress/artifact/terminal events, `markSettled`/`markWorking`, cancellation.

### 5.2 `packages/protocols`

- `a2a/task-control.ts` (new): cumulative counter/limit helpers over
  `protocol_task_control` (active time accrual, MCP/LLM counters, input count,
  remaining budget, expiry), all short transactions, lock order delegation →
  counters.
- `a2a/{server,task-store,message-admission}.ts`: small extensions for the
  per-agent table selection and `inputGeneration` plumbing already sketched in
  Phase 03 (no protocol-semantics change).

### 5.3 `packages/persistence`

- `migrations/0014-agent-governance.sql`: extend `llm_calls` with
  `agent_identity`, `delegation_id`, `task_id`, `trace_id` (nullable, indexed);
  add `delegated_budget_reservations` (delegation/task/attempt/cost/status,
  unique per attempt scope) or reuse `llm_calls` with the new columns plus a
  `protocol_task_control` USD mirror; restricted grants for the flight-agent
  role: protocol task tables, delegated reads (`agent_delegations`,
  `reference_*`, `scenario_snapshots`, `route_validations`,
  `schedule_validations`, `trips` SELECT), ledger reserve/settle via narrowly
  scoped SECURITY DEFINER functions with fixed `search_path` and revoked public
  execute; NO write grants on trips/scenario/selection/proposal/decision/
  reservation tables.
- `delegated-authority.ts` (new): read/validate delegation authority
  (status/deadline/snapshot/domain/generation).
- `llm-calls.ts`: agent/delegation/task/trace correlation on reserve/settle;
  keep existing semantics; `protocol-tasks.ts`, `agent-delegations.ts` small
  extensions; `migrate.ts` + `index.ts`.
- Lock-order fixes in `operations/{finalize,claim}.ts` (section 3).

### 5.4 AI surface

- `packages/ai/src/prompts/recommendation-v2.ts` (flight-aware prompt),
  `context/role-contexts.ts` (`flightRecommendationContextSchema` with
  schedule/price facts, additive), `roles/recommendation.ts` (v2 role +
  limits), `fixture-adapter.ts` (deterministic flight handling), registry
  exports; `recommendation-v1` stays for the graph adapters.
- `packages/services/src/ai/{runtime,authority}.ts`: delegated authority +
  delegated recommendation call with per-attempt reservation, output
  permutation/subset validation, safe fallback.

### 5.5 Scripts/wiring/tests/docs

- `scripts/setup-protocol-roles.ts`: flight-agent role + delegated ledger
  function grants; `ai-profiles.example.json` flight-agent profile; `.env.example`;
  workspace/build/dev files; migration-manifest coverage.
- `tests/unit/ai/flight-recommendation.test.ts`;
  `tests/integration/a2a/{flight,message-deduplication,delegated-governance,transaction-locking}.test.ts`
  (real HTTP/official clients; nonexistent/stale/superseded delegation; invalid
  flight id; rejected route; shared cost races; task limits; uncertain paid
  calls mocked at the adapter boundary; denied domain/reservation writes;
  controlled reserve/finalize/control/reaper interleavings; legacy
  fencing/effect tests retained).
- Docs: extend `docs/protocols/agents.md` (created here) with per-service
  model/profile/credential setup.

## 6. Crash-boundary matrix (proposed verification)

| Boundary | Behavior | Test |
| --- | --- | --- |
| before send | reclaim + deliver persisted message | coordinator-side test in Phase 07; here: agent-side admission only |
| after remote admission / lost acknowledgement | resend identical message id → canonical task, no second execution | `message-deduplication.test.ts` |
| crash before first work | startup reconciliation → `FAILED/AGENT_RESTARTED`, duplicate replays failed task | `flight.test.ts` (crash flag fixture, as Phase 03) |
| while streaming | retrieve canonical task; completed output retrievable | `flight.test.ts` |
| after artifact persistence before completion | artifact cached (`protocol_validated_outputs`), terminal event on resume | `flight.test.ts` |
| cancellation | SDK cancellation + local revocation; late artifacts inadmissible | `flight.test.ts` |

## 7. Validation approach

1. Unit: flight recommendation context/output validation, permutation/subset
   enforcement, limit arithmetic, delegated authority checks.
2. Integration (real processes/HTTP/SDK): card discovery, submit/stream/
   retrieve/cancel, duplicate concurrent sends, conflicting ids, invalid route
   (PRG→ČB cannot become a success), invalid flight id, stale/superseded/
   nonexistent delegation, denied writes (agent role cannot touch
   trips/selections/reservations), shared cost races across two tasks, task
   limits (time/MCP/LLM/USD), uncertain paid-call mock, reaper/finalize/control
   concurrency with no `40P01`.
3. Regression: full unit + integration suites, typecheck/lint, production
   build + bundle verification, isolated E2E smoke (old app unaffected).
4. No paid calls (fixture AI); MCP endpoints from Phase 04 are real HTTP.

## 8. Risks and mitigations

- **Lock-order regression**: the two identified violations are fixed first and
  covered by an explicit concurrency test before delegated reservations are
  enabled.
- **Authority leakage**: delegated authority is a distinct tagged variant;
  `OperationAuthority` is never constructed in agent code paths.
- **Budget reset on continuation**: counters live in `protocol_task_control`
  and reservations in the shared ledger; continuations read the remainder.
- **SDK shape drift**: reuse Phase 03/04 verified plumbing only.
- **Uncertain paid calls**: `unknown_reserved` retained and counted in caps;
  never rerun automatically.

## 9. Acceptance mapping

- Separately running Flight Agent calls MCP and returns a valid structured
  artifact → `flight.test.ts` with the real host + MCP endpoints.
- One canonical message executes once; costs attributed and bounded →
  `message-deduplication.test.ts` + `delegated-governance.test.ts`.
- Agent credentials cannot book or mutate trip state; invalid route cannot
  become a recommendation success → write-denial tests + rejected-route test.
- Retained and new transaction paths obey one lock order → section 3 changes +
  `transaction-locking.test.ts`.
