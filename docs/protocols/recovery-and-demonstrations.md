# Recovery, restart, replacement and demonstration evidence (Phase 10)

This document records the Phase 10 recovery semantics, the deterministic kill
points, the compatible Accommodation Agent B, and the executable evidence for
scenarios A–L of `ODTF_PLAN.md` §5.1. Everything below uses fixture data, the
official A2A/MCP SDKs and real HTTP against independently running processes.

## 1. Recovery rules

| Situation | Persisted behavior | User-visible behavior |
| --- | --- | --- |
| Coordinator dies before an outbound send | The delegation and its outbound payload are committed before HTTP; a later claim re-delivers the **same message id** and payload hash. | No duplicate task, no repeated paid work. |
| Specialist admits a message, then dies before the acknowledgement | The canonical task/message row exists. The coordinator keeps re-delivering the same message id; after restart, admission replays the canonical task and binds its task id. | The task is marked `AGENT_RESTARTED` by startup reconciliation; the coordinator records that safe code and never resumes interrupted computation. |
| Specialist dies while working | Startup reconciliation marks every non-terminal task `failed` with an `AGENT_RESTARTED:` terminal text. | The operation fails explicitly or continues with usable sibling artifacts; an owner retry creates a **fresh** delegation instead of re-polling the dead task. |
| Specialist is `input_required` | The pending question, its generation and expiry survive the restart; reconciliation never fails a resting `input_required` task. | The same task/context accepts the answer after restart; the revision, artifacts and budgets are unchanged. |
| Coordinator dies at a choice/question cursor | The coordinator run row is the cursor; pending decisions and the question queue are durable. A later claim resumes the saved run. | Completed/input-required tasks are retrieved, not re-executed; a replayed decision is refused with `STALE_DECISION` unless it proves a committed effect. |
| Owner retries a terminally failed run | `retryOperation` requeues the operation; the next claim reopens the failed run bound to that operation at `interpreting`, preserving run data. Completed accepted siblings are reused; only the failed scope gets a fresh delegation. | The trip leaves `recovery_required` and resumes instead of wedging; the failed domain is retried once per owner action. |
| Booking committed, cursor not advanced | The confirmed reservation (keyed by `confirm:<service>:<operationId>:<proposalId>`) or the stored `decline_booking` effect is the durable proof. The same operation may replay the decision and the booking service replays idempotently. | Exactly one confirmed reservation or one declined selection; no second charge/booking and no `STALE_DECISION` wedge. |
| Operation cancelled while a specialist works | Cancellation rotates the fence, revokes the delegation and persists a remote-cancel intent in one commit. Every delegation status write (task binding, failure, artifact acceptance) preserves terminal rows. | Late artifacts are inadmissible; the run parks as `cancelled`; the cancel outbox acknowledges or fails with bounded retries. |
| Optional domain fails (e.g. City Guide) | The completed hotel artifact is retained. The coordinator parks the hotel choice; the failed delegation is terminal and one failure event is recorded per scoped domain. | The hotel can still be chosen. When meals are needed later, only the failed City Guide domains are re-researched once per owner operation. |
| Coordinator polls a non-blocking delivery | Specialist sends return the admitted task immediately; the coordinator polls within the claim (research and itinerary steps) and re-delivers the same message id after an abandoned claim. | A question can be queued while a sibling is still working; the drain-before-decision rule is real, not an artifact of blocking HTTP. |
| MCP host is unreachable | The agent's call is bounded by the protocol timeout; the task fails with `MCP_UNAVAILABLE:` and no snapshot is regenerated. | A new task succeeds after the host restarts; the failed task remains failed and auditable. |
| Shared paid budget is exhausted | The reservation functions reject before the call; unknown outcomes keep their reservation. | Safe `TASK_BUDGET_EXCEEDED`/governance codes, never a false success or a retry that double-charges. |

**Limit of recovery:** interrupted agent computation is never resumed. A2A task
persistence preserves the task, message and artifacts, not the executor's
in-memory work. Reconciliation is explicit (`AGENT_RESTARTED`) rather than a
fabricated completion.

## 2. Deterministic kill points

| Kill point | How the tests create it | Evidence |
| --- | --- | --- |
| Before send / lost acknowledgement | Transport outage in `coordinator/recovery.test.ts`; the outbound payload is persisted and re-delivered. | `tests/integration/coordinator/recovery.test.ts` ("re-delivers from the persisted outbound payload"). |
| After remote admission, before acknowledgement | `ODFT_*_AGENT_CRASH=1` exits the specialist after durable admission (`accommodation`, `accommodation-alt`, `city-guide`, `flight` hooks). | `tests/integration/protocols/failure-recovery.test.ts`, `restart.test.ts`. |
| While streaming/working | A specialist is killed after it admits a task; startup reconciliation fails the orphan. | `tests/integration/protocols/restart.test.ts`. |
| After artifact persistence, before ingestion | The coordinator claim is abandoned and the saved task is read by a later claim. | `tests/integration/coordinator/recovery.test.ts` ("resumes a research operation from the saved specialist task"). |
| During `input_required` | Restart an agent whose task is waiting for an answer; the question survives and the same task accepts the continuation. | `tests/integration/a2a/input-required.test.ts` and `sdk-interoperability.test.ts`. |
| After booking commit, before cursor advance | A ports wrapper throws after `confirm` (and after `declineBooking`); the lease expires and the same operation replays. | `tests/integration/coordinator/recovery.test.ts` ("replays a booking committed before the cursor advance exactly once" and the decline variant). |
| Owner retry of a terminal failure | The accommodation specialist fails with `AGENT_RESTARTED`; the owner calls `retryOperation`; the run reopens and only the hotel domain is re-dispatched. | `tests/integration/coordinator/recovery.test.ts` ("reopens a failed run on owner retry"). |
| Question queued while a sibling works, then a coordinator restart | The hotel asks its tradeoff question while a deliberately slow City Guide task is working; the first claim abandons, the City Guide finishes, and the next claim drains before promoting. | `tests/integration/protocols/restart.test.ts` ("promotes a queued hotel question only after a working City Guide sibling drains"). |
| Cancellation races | Cancel while a slow specialist is working; cancel concurrently with a question answer; accept a late artifact on a revoked delegation. | `tests/integration/protocols/cancellation.test.ts`. |
| MCP outage/timeout | Stop the MCP host, send a task, restart the host and send a fresh task. | `tests/integration/protocols/failure-recovery.test.ts`. |

## 3. Accommodation Agent B (compatible replacement)

| Item | Value |
| --- | --- |
| Application | `apps/accommodation-agent-alt` |
| Identity / card | `accommodation-agent-alt`, skill `accommodation.recommend.v1` |
| Default bind | `127.0.0.1:4404` (`ODFT_ACCOMMODATION_ALT_AGENT_HOST` / `..._PORT`) |
| Task storage | `odft_protocol.agent_tasks_accommodation_alt` (its own table) |
| DB role | `odft_accommodation_agent` (the same least-privilege profile; no trip/scenario/reservation writes) |
| Strategy | Independent value score (`0.6 × normalized price + 0.4 × normalized centre distance`); cheapest/distance-first orders when the traveler answers the tradeoff question |
| Model profile | Optional `ODFT_ACCOMMODATION_ALT_AI_CONFIG_PATH` (a distinct profile) or the shared `AI_CONFIG_PATH`; fixture mode stays deterministic and free |
| Input-required | Same contract, options and continuation semantics; its own request id prefix `accommodation-alt-tradeoff:` |

The executor imports the public contracts, SDK plumbing, deterministic read
services and governed AI wiring, but **no code from
`apps/accommodation-agent`**. The MCP host allowlists the new identity for the
same hotel domain (`apps/mcp-server/src/config.ts`).

### Registry switch

1. Start `accommodation-agent-alt` with its own port, token and task table.
2. Replace the accommodation entry in the trusted registry (or put B before A).
   `loadCoordinatorTransportConfig` selects the first entry with the required
   skill; the coordinator source is unchanged.
3. Restart the worker so the registry is re-read. Tasks already bound to A keep
   their persisted endpoint/task id; new accommodation work goes to B.

`agent-registry.example.json` contains both entries (A first by default);
`tests/fixtures/protocols/agent-registry-coordinator-alt.json` is the switched
fixture used by the replacement tests.

## 4. Scenario A–L evidence

| Scenario | Executable evidence |
| --- | --- |
| A — Agent discovery | `tests/integration/a2a/*.test.ts`, `tests/integration/coordinator/admission.test.ts`; the e2e inspector renders discovered cards. |
| B — Independent delegation | `tests/integration/a2a/{flight,accommodation,city-guide}.test.ts`; real HTTP tasks and validated v1 artifacts. |
| C — MCP discovery | `tests/integration/mcp/*.test.ts`; official client discovery/invocation and safe telemetry. |
| D — Parallel execution | `tests/integration/a2a/parallel-research.test.ts`; overlapping specialist execution windows and persisted aggregation. |
| E — Additional information | `tests/integration/a2a/{input-required,accommodation-alt}.test.ts`; queue-before-drain, same-task continuations, and the drain-across-restart case in `tests/integration/protocols/restart.test.ts`. |
| F — Streaming | `tests/integration/protocols/sdk-interoperability.test.ts`, `tests/e2e/sse-replay.spec.ts`; real status events and deduped replay. |
| G — Agent failure | `tests/integration/protocols/failure-recovery.test.ts`; explicit `AGENT_RESTARTED`, preserved hotel, scoped City Guide retry. |
| H — MCP failure | `tests/integration/protocols/failure-recovery.test.ts` ("MCP outage"); `tests/integration/mcp/*` timeouts. |
| I — Hotel re-planning | `tests/integration/coordinator/selective*.test.ts`, `tests/e2e/phase-07.spec.ts`; hotel-only refresh and confirmation. |
| J — Agent replacement | `tests/integration/protocols/agent-replacement.test.ts`, `tests/e2e/agent-replacement.spec.ts`; registry-only switch, old A binding retained. |
| K — Restart recovery | `tests/integration/protocols/restart.test.ts`, `failure-recovery.test.ts`, `coordinator/recovery.test.ts`; coordinator/agent restarts, canonical task reuse, commit-before-cursor replay (confirm and decline), and owner retry of a terminal failure. |
| L — Booking safety | `tests/integration/{graph,coordinator}/booking*.test.ts`, `tests/e2e/phase-07.spec.ts`; `DEMO-*` references, explicit consent, one confirmed service, idempotent replay. |

## 5. Running the evidence

```bash
# Unit suite
npm run test:unit

# One affected integration file at a time (isolated database)
TEST_DATABASE_URL=postgres://.../odft_test npx vitest run tests/integration/protocols/failure-recovery.test.ts

# Phase 10 e2e specs on an isolated fixture stack (built web app, port 3100)
DATABASE_URL=postgres://.../odft_phase01_test \
PUBLIC_BASE_URL=http://localhost:3100/ \
npx playwright test tests/e2e/{protocol-failures,agent-replacement}.spec.ts --project=desktop
```

The e2e helper (`tests/e2e/_services.ts`) starts the MCP host, all specialists
and a coordinator-enabled worker against the same isolated database as the web
server. It reuses the integration process helpers so the protocol wiring cannot
drift from the tested configuration.
