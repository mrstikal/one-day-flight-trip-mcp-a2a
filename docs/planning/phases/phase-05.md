# Phase 05 - Durable Graph Core: Worker, PostgreSQL Queue, Fencing, and Official Checkpointer

Status: implementation plan (planning only). No application code, worker, or test exists on 2026-10-10. All code
blocks are future targets. This phase ships the durable execution core and a minimal test-only graph harness that
proves the LangGraph invocation/interrupt/crash contract. It does NOT ship the business planner, real LLM calls,
provider loops, or the full UI.

## 1. Goal

Make graph execution durable and single-writer correct: a Node.js worker that claims queued operations from
PostgreSQL with `FOR UPDATE SKIP LOCKED`, holds a per-trip advisory lock, renews a lease/fencing token, drives
official PostgresSaver checkpoints through a fenced wrapper, and recovers crashes. Prove the invocation contract,
parallel `Send` reducer, single interrupt, and re-entry with a deterministic test-only graph. Owns FR-GRAPH-1..6,
FR-SEC-1..4, and the minimal FR-UI-4 (202/SSE) surface.

## 2. Prerequisites

- Phase 03 (operations/effects/decisions tables, `BookingService`, admission) and Phase 04 (deterministic
  services the harness can call) complete.
- Phase 01 `npm run checkpointer:setup` command exists; pin `@langchain/langgraph` 1.4.21,
  `@langchain/core` 1.2.17, `@langchain/langgraph-checkpoint-postgres` 1.0.6.
- Real PostgreSQL 17 at `TEST_DATABASE_URL`; integration tests must use it and never a mocked checkpointer.

## 3. Source Inputs (authoritative)

- docs/planning/02-architecture.md sections 6-10 (admission, worker ownership, fenced checkpoint writes, effect
  reconciliation, SSE/read API, config).
- docs/planning/03-langgraph-design.md sections 2-9, 11 (state/ownership, node contracts, reducers, interrupt,
  invocation/recovery contract, bounds).
- docs/planning/04-domain-model.md section 7 (decisions/resume, `GraphResumeEnvelope`), section 9 (`workflow_*`,
  `execution_events`, `pending_decisions`).
- docs/planning/10-security-reliability.md sections 2, 4, 9, 10 (sessions/cookies, CSRF, error taxonomy, restart).
- docs/planning/01-functional-requirements.md FR-GRAPH-1..6, FR-SEC-1..4, FR-UI-4 (subset).
- docs/planning/11-testing-strategy.md T-IT-INV-01..08, T-IT-FLT-01..07, T-IT-RED-01/02, T-IT-OPS-01,
  T-IT-LIM-04, Phase 05 gate.
- Read current docs; older comments are not authoritative.

## 4. Binding Decisions (do not re-decide)

- One writer per trip: only the worker invokes graphs. Browser/BFF handlers enqueue operations and never invoke
  threads. A session-level advisory lock plus lease/fencing token guards execution; a lost lock/heartbeat
  connection aborts local work immediately.
- Claim with `FOR UPDATE SKIP LOCKED` and a lease; default lease 60 s, renew every 15 s. Domain/event writes
  require the current fencing token and accepted revision.
- Fenced checkpoint writes: wrap official saver `put` and `putWrites` with an operation-bound guard. The guard
  acquires a separate short transaction-scoped `checkpoint-write:<tripId>` advisory gate, reads the current
  operation/fencing token with a NON-LOCKING ownership read, delegates the official write only if still current,
  and releases the gate after the delegated write finishes. Lease claim/fencing-token rotation acquires the SAME
  gate before committing a new token, so an already-admitted write finishes before rotation and every later stale
  write is rejected. The guard carries the immutable current driver operation context, not a token read from old
  checkpoint state. Never hold an operation-row lock inside the checkpoint gate (lock-order cycle with job
  claiming). Use a SEPARATE bounded saver pool so the outer guard transaction cannot starve its own delegated
  write. No SQL transaction spans an LLM call.
- Trusted `GraphResumeEnvelope` updates the resumed graph's operationId/acceptedRevision and resets per-operation
  counters/work scope BEFORE any later effect; otherwise a resumed graph would keep the old operation ID and
  mis-key booking effects. Public decision responses exclude `modify`; the worker constructs the internal
  response only from an admitted operation.
- Accepted-resume recovery replays the STORED same envelope even if that decision was already resolved by a
  committed effect; this never admits a new request or a changed payload. Recovery of the same operation retains
  its existing scope and counters (no original-operation counter reset on recover).
- Invocation contract (03 section 8): new thread = plain validated input; new command after `END` = plain
  new-operation input restarting at `START` with persisted state; exact pending decision = `Command({resume})`;
  unfinished tasks with no unanswered interrupt = `null`; `null` on a completed thread is a no-op; resume without
  a matching interrupt = stale conflict without invoking. Never use input `Command({update})` after `END`, and
  never use `null` to start a modification.
- Each invocation uses `configurable: { thread_id }`, top-level `durability: "sync"`, top-level
  `recursionLimit: 100`, server `context` with the authoritative current operation/fencing identity, and an abort
  signal. Consume the whole stream and await checkpoint writes before releasing ownership.
- One generic pure interrupt node with a strict `DecisionKind`; one pending decision per trip; no side effects,
  budget charges, or counters before the interrupt; never wrap the interrupt in a catch that swallows
  `GraphInterrupt`; no interrupts inside parallel research.
- Reducers persist across invocations, so merging `{}` does not clear a map. New runs clear per-operation scope
  through a serial-node `Overwrite`; NEVER clear reducer state from a parallel worker.
- Session security: CSPRNG 256-bit token, HMAC-SHA-256 hash stored (never the raw token), HttpOnly cookie,
  SameSite `Lax`, 30-day sliding expiry. Ordinary renewal does NOT rotate the cookie secret (concurrent tabs stay
  owned); CSRF is a stable derived per-session HMAC value returned after reload. `PUBLIC_BASE_URL` origin check.
- Driver recovery:3 automatic claims per explicit round, then owner technical retry of the same unfinished operation. Total counts and graph/provider/AI limits never reset; ordinary new commands get RECOVERY_REQUIRED until recovered.

## 5. Detailed Ordered Steps

1. Extend Phase 01 `packages/persistence/src/checkpointer-setup.ts` so `checkpointer:setup` runs the official
   PostgresSaver `await setup()` inside the `odft_checkpoint` schema and verifies the official tables exist;
   workers refuse to claim until setup and a recent Phase 01 `worker_heartbeats` row are present.
2. Implement the worker app (`apps/worker`): claim loop with `FOR UPDATE SKIP LOCKED` + lease, per-trip advisory
   lock on a dedicated connection, lease heartbeat at 15 s, graceful shutdown that stops claims and aborts or
   finishes within 30 s, and bounded `WORKER_CONCURRENCY` (2 trips, never concurrent invocations of one trip).
3. Implement `chooseInvocation(state, operation)` returning the exact invocation from section 4 (plain input,
   `Command({resume})` with the stored envelope, or `null`), after reconciling domain inputs and `getState`.
4. Implement the fenced saver wrapper around the official PostgresSaver with the separate gate, non-locking
   ownership read, separate bounded pool, and rotation on the same gate.
5. Build the test-only durable harness in `packages/workflow/src/harness/`: `StateSchema` (Zod) with a keyed
   reducer map `researchRunId:domain`, one `await_decision` interrupt node, a `Send` fan-out to a deterministic
   test `research_domain` node, a single static edge into `join_research`, a serial-node `Overwrite` reset, and an
   `END`. This harness proves the contract; it calls no LLM.
6. Wire session/CSRF/rate limits, strict admission/resume, technical retry, and Phase02 read-only reference handlers. Reject new ordinary commands on unfinished failed work. Creation HTTP is Phase06; use owned fixture trips for the harness.
7. Implement `GET /api/trips/:id/events` SSE with persisted monotonic bigint event IDs serialized as decimal
   strings, `Last-Event-ID`/`after` replay, deduplication, and a 15 s heartbeat; expose
   `GET /api/trips/:id/operations/:operationId` for durable status. Provide `GET /api/trips/:id` as the polling
   fallback.
8. Implement recovery: commit-before-checkpoint replay reads the effect ledger; checkpoint-written-but-unreconciled
   recovery repairs the projection/events; `GRAPH_VERSION_UNSUPPORTED` refuses incompatible checkpoints.
9. Write the tests in section 10 against real PostgreSQL and real worker processes.

## 6. Concrete Target Paths

```text
apps/worker/src/{main,claim,lease,trip-lock,driver,shutdown}.ts
apps/worker/src/checkpointer/fenced-saver.ts
packages/workflow/src/harness/{graph,state,test-domain-node,interrupt}.ts           # @odft/workflow
packages/workflow/src/invocation/{choose-invocation,reconcile}.ts
packages/persistence/src/operations/{claim,lease,fencing}.ts                        # @odft/persistence
apps/web/src/app/api/trips/[id]/{commands,resume,events}/route.ts
apps/web/src/app/api/trips/[id]/operations/[operationId]/route.ts
apps/web/src/app/api/trips/[id]/operations/[operationId]/retry/route.ts
apps/web/src/app/api/reference/{countries,cities,airports}/route.ts
apps/web/src/app/api/reference/cities/[id]/airports/route.ts
apps/web/src/app/api/trips/[id]/route.ts
apps/web/src/app/api/session/route.ts
apps/web/src/lib/{session,csrf,rate-limit}.ts
tests/integration/graph/{invocation,reducers,interrupt,recovery}.test.ts
tests/integration/worker/{lease-fencing,restart,checkpoint-fence}.test.ts
tests/e2e/restart.spec.ts   # minimal 202/SSE + restart recipe harness only
```

## 7. Functions and Interfaces to Implement

```typescript
runWorker(config: WorkerConfig): Promise<void>;
claimNextOperation(pool: Pool): Promise<ClaimedOperation | null>;         // FOR UPDATE SKIP LOCKED + lease
renewLease(pool: Pool, claim: ClaimedOperation): Promise<void>;
acquireTripLock(pool: Pool, tripId: string): Promise<TripLock>;           // session advisory lock
releaseTripLock(lock: TripLock): Promise<void>;

buildFencedSaver(saver: PostgresSaver, ctx: OperationContext): FencedSaver; // put/putWrites guarded
chooseInvocation(state: GraphState | null, operation: WorkflowOperation):
  | { kind: "start"; input: StartInput }
  | { kind: "resume"; envelope: GraphResumeEnvelope }
  | { kind: "recover"; input: null }                                      // MUST invoke unfinished work with null
  | { kind: "reconcile" };                                               // completed checkpoint; no graph work

createSession(): Promise<SessionProjection>;                              // CSPRNG token, hashed, cookie
renewSession(sessionId: string): Promise<SessionProjection>;              // extends expiry, keeps secret
getCsrf(sessionId: string): string;                                       // stable derived value
// admitOperation is the Phase 03 admission function; this phase only wires it into the route handler.
admitOperation(input: { tripId: string; session: Session; request: CommandRequest }): Promise<OperationQueued>;
admitResume(input: { tripId: string; session: Session; request: ResumeRequest }): Promise<OperationQueued>;
retryOperation(input: OwnedTechnicalRetryRequest): Promise<OperationQueued>; // same op/revision, explicit recovery round

buildHarnessGraph(): CompiledGraph<HarnessState>;                         // test-only, no LLM
```

## 8. Outputs / Deliverables

- Worker with claim/lease/fencing/advisory-lock loop and graceful shutdown.
- Fenced official PostgresSaver wrapper with separate gate and bounded pool.
- Test-only durable harness graph (StateSchema, keyed reducer, one interrupt, `Send` fan-out, join, `Overwrite`).
- BFF session/CSRF/admission/resume routes returning `202`, SSE event stream, and operation-status route.
- Recovery paths (commit-before-checkpoint, checkpoint-without-event, `GRAPH_VERSION_UNSUPPORTED`).
- Integration/fault tests listed in section 10.

## 9. Measurable Acceptance Criteria

- AC-05-1: the checkpointer is `@langchain/langgraph-checkpoint-postgres`; no memory saver can pass the restart
  test (T-IT-FLT-05).
- AC-05-2: new thread starts at `START`; new command after `END` restarts from `START` with persisted state;
  `null` on a completed thread is a no-op (T-IT-INV-01/02/05).
- AC-05-3: resume uses the trusted envelope, updates operation identity/revision/counters before effects, and
  resumes the exact interrupt without duplicated side effects; `modify`/operation-identity injection is rejected
  (T-IT-INV-03).
- AC-05-4: `null` recovery reruns only unfinished tasks and retains completed siblings' pending writes
  (T-IT-INV-04, T-IT-FLT-03).
- AC-05-5: stale domain writes and saver `put`/`putWrites` are rejected after fencing-token rotation; the gate
  lets admitted writes finish before rotation, uses a non-locking ownership read and separate pool, and cannot
  deadlock with claiming (T-IT-FLT-07).
- AC-05-6: commit-before-checkpoint replay returns the stored effect result with exactly one reservation; a
  checkpoint without its completion event repairs the projection without booking again (T-IT-FLT-01/02).
- AC-05-7: worker restart mid-operation and at an interrupt recovers the same trip thread and reservations;
  PostgreSQL restart recovers lease expiry/renewal (T-IT-FLT-04/05/06).
- AC-05-8: keyed reducer merges unique keys, replaces an equal key only with the identical result, rejects
  conflicting same-key results; zero domains route directly to the next serial node (T-IT-RED-01/02).
- AC-05-9: an HTTP `202` is not success; the UI-affecting projection only reports success after the persisted
  outcome (T-IT-OPS-01 subset).
- AC-05-10:3 automatic claims per explicit round; ordinary requests on exhausted unfinished work are rejected, owner retry requeues the same operation/revision/scope (T-IT-INV-09, T-IT-LIM-04).

## 10. Commands and Tests

```text
npm run checkpointer:setup
npm run db:migrate
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration   # T-IT-INV-01..08, T-IT-FLT-01..07, T-IT-RED-01/02, T-IT-OPS-01, T-IT-LIM-04
npm run test:e2e           # minimal 202/SSE + restart harness only
npm run build
```

Fault tests must observe real processes and real PostgreSQL 17, never a mocked checkpointer. The harness is
test-only; actual LLM/provider/planner bounded-loop tests wait for Phases 08/09/10 and must not be claimed here.

## 11. Explicit Out of Scope

- Business planner, itinerary/review loops, real recommendation ranking (Phases 09/10).
- LLM adapter, prompts, cost ledger, fixture/live intent (Phase 08).
- Hotel/meal/activity UI, itinerary timeline, inspector, map (Phases 07, 11).
- Real provider integrations; any second HTTP service; Redis/broker.

## 12. Common Mistakes / Traps

- Wiring a memory saver or claiming restart recovery without the official PostgresSaver.
- Catching `GraphInterrupt` or doing side effects/counter increments before the interrupt.
- Using input `Command({update})` after `END`, or `null` to start a new modification.
- Clearing a reducer map from a parallel worker, or assuming `{}` clears a reducer.
- Holding an operation-row lock inside the checkpoint-write gate (lock-order cycle with claiming), or sharing one
  pool so the outer guard starves the delegated write.
- Rotating the cookie secret on ordinary renewal (races concurrent tabs out) or storing the raw session token.
- Resetting per-operation counters on recovery, or replaying a changed payload as if it were the stored envelope.
- Marking success from a completed stream instead of the persisted outcome; forwarding raw `values`/`debug` to the
  browser.

## 13. Completion Checklist

- [ ] Official PostgresSaver wired; `checkpointer:setup` verified; no memory saver.
- [ ] Worker claim/lease/fencing/advisory-lock/shutdown implemented; never two invocations of one trip.
- [ ] Fenced saver wrapper matches section 4 (separate gate, non-locking read, separate pool, rotation order).
- [ ] Invocation table + trusted envelope + recovery implemented exactly.
- [ ] Sessions/CSRF/rate-limit + admission/resume routes enqueue only (`202`).
- [ ] SSE replay/dedup/heartbeat + polling fallback + operation-status route.
- [ ] Harness graph proves reducer/interrupt/`Send`/`Overwrite` contract.
- [ ] T-IT-INV-01..08, T-IT-FLT-01..07, T-IT-RED-01/02, T-IT-OPS-01, T-IT-LIM-04 pass on real PostgreSQL.
- [ ] No file outside this phase's paths; no commit made.

## 14. Pasteable Executor Prompt

```text
Implement ONLY Phase05 against completed Phases01-04; reuse services and the Phase01 worker/bootstrap.
Analyze -> implement -> verify, then STOP before Phase06; follow roadmap common rules.

Read first: AGENTS.md, agent-memory/index.md, invariants.md, docs/planning/02-architecture.md (6-10),
03-langgraph-design.md (2-9, 11), 04-domain-model.md (7, 9), 10-security-reliability.md (2, 4, 9, 10),
01-functional-requirements.md FR-GRAPH-1..6/FR-SEC-1..4, 11-testing-strategy.md T-IT-INV/FLT/RED/OPS/LIM. Use
current docs, not older comments.

Analysis (no code): restate the invocation contract table, the fenced checkpoint-write rules (separate gate,
non-locking ownership read, separate bounded pool, rotation on the same gate), and the reducer/Overwrite reset
rules. Confirm the harness is test-only and calls no LLM.

Implement exactly docs/planning/phases/phase-05.md sections 5-7: worker claim/lease/fencing/advisory-lock, fenced
saver wrapper, harness graph, invocation selection + recovery, BFF session/CSRF/admission/resume, and SSE. No
business planner, no real LLM/provider loops.

Verify: npm run checkpointer:setup, npm run db:migrate, npm run typecheck, npm run lint, npm run test:unit,
npm run test:integration, npm run test:e2e, npm run build - all against real PostgreSQL and real worker
processes. Show real output. Add only this phase's tests.

Report changed files, AC-05-1..10 results, and any unresolved issue. Then STOP. Do not start Phase 06.
```
