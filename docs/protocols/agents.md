# Specialist agents (Phase 05)

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
  agent.

### Tests

`tests/integration/a2a/{flight,message-deduplication,delegated-governance,transaction-locking}.test.ts`
spawn the real MCP host and the real agent over HTTP: card/artifact validation,
streamed lifecycle, restart persistence, crash-window reconciliation,
concurrent duplicate sends, conflicting ids, revoked/wrong-snapshot authority,
an infeasible route that cannot become a success, write denial, the shared trip
caps and the scripted paid path (reservation, validation-before-settlement,
unknown-outcome retention, one-winner concurrency, verbatim governance codes),
plus the shared lock-order concurrency checks.
