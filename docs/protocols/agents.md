# Specialist agents (Phase 05–06)

Three independently running A2A services — Flight (`flight.recommend.v1`),
Accommodation (`accommodation.recommend.v1`) and City Guide
(`city-guide.research.v1`) — share the same admission/limits/governance
plumbing (`packages/protocols/src/a2a/executor-support.ts`) and the same
least-privilege database profile, but implement their executors independently.

## Flight Agent (`apps/flight-agent`)

An independently running A2A service that ranks schedule-valid flight
combinations of a delegated frozen snapshot. It generates no flights, writes no
trip state and books nothing.

### Endpoint and identity

| Item | Value |
| --- | --- |
| Identity / card | `flight-agent`, `/ .well-known/agent-card.json`, skill `flight.recommend.v1` |
| Default bind | `127.0.0.1:4401` (`ODFT_FLIGHT_AGENT_HOST` / `ODFT_FLIGHT_AGENT_PORT`) |
| Protocol | modern A2A 1.0 JSON-RPC only, durable admission middleware, single-instance service lock |
| Task storage | `odft_protocol.agent_tasks_flight` (official SDK store) |

### Database roles

- `odft_flight_agent` (created by `scripts/setup-protocol-roles.ts`; the
  agent's `DATABASE_URL` **must** be this restricted role's connection): task
  storage, admission tables, task-control counters, observations, delegated
  authority READS, and EXECUTE on the delegated ledger functions. It has **no**
  write privilege on trips, scenario, selection, proposal, decision or
  reservation tables (proven by test).
- The delegated ledger functions (`odft_app.reserve_delegated_call`,
  `settle_delegated_call`, `mark_delegated_call_unknown`, `claim_delegated_task`)
  are SECURITY DEFINER with a fixed `search_path`, validate the
  service/delegation/task binding and lock in §3.8 order (trip → delegation →
  counters/ledger).

### Governance

- Every paid LLM transport attempt is reserved before sending; a continuation
  gets only the remaining allowance. Uncertain outcomes stay `unknown_reserved`
  and keep counting against the task and trip caps.
- Task limits (`flight.recommend.v1`): 60 s active execution (human waiting
  excluded), 4 MCP invocations including retries, 2 LLM transport attempts,
  USD 0.10 reserved+actual. The active-execution deadline is checked before
  every MCP invocation and before the paid call; the invocation allowance is
  re-read before each call.
- The ranking output must be a permutation/subset of the supplied
  schedule-valid combination ids; the permutation is validated **before** the
  call is settled (the ledger records the real validation status) and anything
  else falls back to the deterministic order (price, then travel time, then id)
  and labels the artifact.
- In `AI_MODE=openrouter` the agent builds a governor-free `OpenRouterAdapter`
  with a single transport attempt per reservation: the delegated runtime
  reserves/settles that attempt against the restricted ledger functions, never
  through the coordinator's fenced `reserveCall`. A task-level re-attempt needs
  a new reservation, bounded by the per-scope attempt limit.

### Configuration

```bash
# One-time roles (also creates the protocol and read-only roles).
ODFT_FLIGHT_AGENT_PASSWORD=... npm run protocol:roles

# Start (uses .env, the trusted registry and the MCP services registry).
npm run dev:flight-agent        # tsx watch
npm run build:flight-agent      # compile to apps/flight-agent/dist
node apps/flight-agent/dist/main.js

curl http://127.0.0.1:4401/health
```

Environment: `ODFT_FLIGHT_AGENT_REGISTRY_PATH` (inbound trusted identities),
`ODFT_MCP_REGISTRY_PATH` (Phase 04 endpoints), `ODFT_AGENT_TOKEN_FLIGHT`,
`AI_MODE` (`fixture` by default; `openrouter` requires `AI_CONFIG_PATH` with a
validated `recommendation` profile), `ODFT_FLIGHT_AGENT_CRASH=1` (test-only
crash-before-work hook).

### Lifecycle and recovery

- Admission commits the canonical task + mapping before work (Phase 03
  guarantee); duplicates replay the persisted task, conflicting payloads are
  refused.
- Every executor invocation publishes the initial task event, then real
  progress (`MCP discovery`, query completion), the validated artifact and a
  terminal status.
- Startup reconciliation (under the service lock) marks tasks a stopped process
  left active as `FAILED`/`AGENT_RESTARTED`; completed output stays retrievable.
- A terminal task cannot be cancelled (SDK semantics). Accepted cancellation of
  a live task performs local revocation first: the control row records
  `cancel_requested_at` and the `cancelled` state, and a running invocation
  checks that row before publishing its artifact or completion. The wide
  input-required window that exercises this end to end arrives with the Phase 06
  agent (§ input-required below).

### Tests

`tests/integration/a2a/{flight,message-deduplication,delegated-governance,transaction-locking}.test.ts`
spawn the real MCP host and the real agent over HTTP: card/artifact validation,
streamed lifecycle, restart persistence, crash-window reconciliation,
concurrent duplicate sends, conflicting ids, revoked/wrong-snapshot authority,
an infeasible route that cannot become a success, write denial, the shared trip
caps and the scripted paid path (reservation, validation-before-settlement,
unknown-outcome retention, one-winner concurrency, verbatim governance codes),
plus the shared lock-order concurrency checks.

## Accommodation Agent (`apps/accommodation-agent`)

| Item | Value |
| --- | --- |
| Identity / card | `accommodation-agent`, skill `accommodation.recommend.v1` |
| Default bind | `127.0.0.1:4402` (`ODFT_ACCOMMODATION_AGENT_HOST` / `..._PORT`) |
| Task storage | `odft_protocol.agent_tasks_accommodation` |
| DB role | `odft_accommodation_agent` (restricted, same profile as the flight agent) |
| MCP scope | `odft-travel-data` `search_hotels` + `get_scenario_metadata` (hotel domain only) |

- Deterministic eligibility comes from the delegated query itself (effective
  level / dates / party / luggage / objective override applied by the read
  service); the local ranking is price-then-id (`rankDeterministically`).
- Optional governed comparison reuses the recommendation role (v1 prompt,
  `target:"hotel"`) through the generic `rankDelegatedOffers`; the artifact
  reports the request's `effectiveLevel` and `searchObjective` and comparison
  facts (price + centre distance).
- **Genuine tradeoff question** (plan §3.10): a `cheaper` search whose eligible
  set contains a hotel within a 50 % price premium of the cheapest that is at
  least 1.5 km and 40 % relatively closer to the centre (and no preference
  decides) is ambiguous. The agent persists a `AgentInputRequestV1`
  (options `cheapest`/`central`, stable `requestId`, 24 h expiry), publishes
  `TASK_STATE_INPUT_REQUIRED` and counts one input (max two). A fully specified
  request never asks.
- A continuation must validate against the persisted pending question: the
  admission-incremented `input_generation`, the answered `requestId` and the
  expiry; the binding is consumed exactly once (compare-and-swap), so a second,
  different answer can never be accepted. The stored `input_request_hash` is
  correlation evidence (the contract's continuation payload carries no hash).
  The chosen option selects the deterministic order (price-first or
  distance-first). Counters are never reset by a continuation.
- Task limits: 60 s active / 4 MCP / 2 LLM attempts / USD 0.10 (the paid
  comparison is reserved only in `AI_MODE=openrouter`).

## Accommodation Agent B (`apps/accommodation-agent-alt`)

| Item | Value |
| --- | --- |
| Identity / card | `accommodation-agent-alt`, skill `accommodation.recommend.v1` |
| Default bind | `127.0.0.1:4404` (`ODFT_ACCOMMODATION_ALT_AGENT_HOST` / `..._PORT`) |
| Task storage | `odft_protocol.agent_tasks_accommodation_alt` |
| DB role | `odft_accommodation_agent` (same restricted profile) |
| MCP scope | `odft-travel-data` `search_hotels` + `get_scenario_metadata` (hotel domain only) |

- Phase 10 replacement implementation. It shares the public request/artifact
  contracts, official SDK plumbing, deterministic read services and governed AI
  infrastructure, but imports **no code** from `apps/accommodation-agent`.
- Its strategy is a value score (`0.6 × normalized price + 0.4 × normalized
  centre distance`); answering the tradeoff question selects the cheapest-first
  or distance-first order. It uses its own optional model profile
  (`ODFT_ACCOMMODATION_ALT_AI_CONFIG_PATH`) and the same task limits.
- It asks the same genuine price-versus-location question with request id prefix
  `accommodation-alt-tradeoff:`; eligibility, continuation validation and output
  contracts are identical.
- The MCP host allowlists `accommodation-agent-alt` for the same hotel domain.
- Switching the trusted registry's accommodation entry from A to B requires no
  coordinator source change; see
  `docs/protocols/recovery-and-demonstrations.md` and
  `tests/integration/protocols/agent-replacement.test.ts`.

## City Guide Agent (`apps/city-guide-agent`)

| Item | Value |
| --- | --- |
| Identity / card | `city-guide-agent`, skill `city-guide.research.v1` |
| Default bind | `127.0.0.1:4403` (`ODFT_CITY_GUIDE_AGENT_HOST` / `..._PORT`) |
| Task storage | `odft_protocol.agent_tasks_city_guide` |
| DB role | `odft_city_guide_agent` (restricted, same profile) |
| MCP scope | `odft-travel-data` `search_restaurants`/`search_attractions`/`search_events` + `get_scenario_metadata` |

- Preserves the EXACT requested meal/activity/event domains (order preserved,
  duplicates removed); domains outside its skill become explicit `unsupported`
  outcomes, never dropped; a requested domain outside the delegated scope fails
  the task before any work (`DELEGATION_REVOKED`).
- Bounded parallel queries (concurrency three) and per-domain outcomes: a
  completed domain is always retained; the task completes with the artifact when
  at least one domain succeeded, otherwise fails (`MCP_UNAVAILABLE`). Provider
  faults surface as labeled `retryable_error`/`unavailable` outcomes with
  `simulatedFailure`.
- Deterministic ranking only: meals by price then id, attractions keep the
  preference/reference order of the read service, events by id. No LLM call in
  Phase 06 (the 2-attempt budget stays a documented ceiling).
- `inputFingerprint` per outcome comes from the task request's
  `queryContext.domainInputFingerprints[domain]` (never invented).
- Task limits: 90 s active / 8 MCP / 2 LLM attempts / USD 0.10.

## Input-required and continuations (persistent generations)

- `migrations/0015-agent-input.sql` adds `input_request_id`, `input_request_hash`
  and `input_expires_at` to `protocol_task_control`; admission already
  increments `input_generation` on any continuation message.
- The question artifact advertises the generation the question belongs to; the
  ANSWER must carry that value **plus one**, because admission increments the
  task's `input_generation` when the continuation message arrives (the executor
  matches the message value against the incremented row).
- Only a continuation that matches the persisted pending question is accepted;
  wrong id/generation → `STALE_AGENT_RESULT`, past expiry → `INPUT_EXPIRED`,
  revoked authority → `DELEGATION_REVOKED`, an unknown option fails the task and
  consumes the binding (never re-asks). A duplicate message id is answered by
  admission with the persisted canonical task (no second execution).
- `input_required` is a resting state: reconciliation across a restart never
  fails it, and the pending question survives (tested).

## Tests (Phase 06)

`tests/integration/a2a/{accommodation,city-guide,input-required,parallel-research}.test.ts`
and the extended `delegated-governance` suite spawn the real agents and the MCP
host over HTTP: card/artifact validation, requested-domain exactness, partial
success retention, the tradeoff question and its continuation, duplicate
answers, expiry, restart while awaiting input, revoked authority, cumulative
caps, least-privilege write denial, the hotel-context paid comparison and
overlapping parallel execution windows.

Phase 10 adds `tests/integration/a2a/accommodation-alt.test.ts` (the
independent replacement executor), `tests/integration/protocols/{failure-recovery,restart,cancellation,agent-replacement}.test.ts`
(real outage/restart/cancel/replacement races) and
`tests/e2e/{protocol-failures,agent-replacement}.spec.ts` (browser evidence).
