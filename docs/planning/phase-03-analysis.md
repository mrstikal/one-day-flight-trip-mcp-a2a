> **Historical planning material.** This document describes the retired LangGraph runtime and is kept for context only. The active architecture is `docs/architecture/coordinator.md`; the final gate is `docs/planning/migration-results.md`. LangGraph/checkpointer commands and test IDs below are historical and are not part of the active runtime.

# Phase 03 analysis — contracts, protocol persistence and SDK interoperability

Analysis pass of the two-pass workflow (ODTF_PLAN.md §4 preamble). **No code was
changed for this document.** It proposes the exact implementation and validation
approach and requests approval before the implementation pass.

## 1. Scope, constraints and exclusions

In scope (plan Phase 03): versioned SDK-independent contracts, official A2A and
MCP SDK plumbing over real HTTP, protocol persistence (migration `0013`), a
trusted registry/auth/telemetry layer, durable inbound admission/outbound
records, and interoperability proof. Out of scope: production specialists,
new default engine, legacy archival, paid model calls, business MCP tools
(Phase 04), any graph-path behavior change.

Hard constraints carried over: existing-engine defaults and legacy trips
untouched; admission rules, public domain contracts and applied migration
checksums preserved; browser contracts stay free of SDK/DB dependencies; no
committed login secrets; no trip archived.

## 2. Verified SDK facts (step 1 of the phase)

Registry and declaration inspection (tarballs unpacked read-only; nothing
installed into the repo yet):

| Package                        | Version                 | Verified surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@a2a-js/sdk`                  | 1.3.0                   | `./server/database` → `DatabaseTaskStore(db: Kysely<DB>, { tableName?, ownerResolver? })` with `save/load/list(task\|id, ServerCallContext)`; `TaskState` numeric enum (`TASK_STATE_SUBMITTED=1`, `TASK_STATE_INPUT_REQUIRED=6`); protobuf-style `Part.content` `$case` unions; `./server/express` → `agentCardHandler`, `jsonRpcHandler`, `UserBuilder`; `./client` → `ClientFactory`, `JsonRpcTransportFactory`, `DefaultAgentCardResolver`, `createAuthenticatingFetchWithRetry`; `DefaultRequestHandler(agentCard, taskStore, agentExecutor, …)`; CLI bin `a2a-db` (offline SQL generation) |
| `@modelcontextprotocol/server` | 2.3.1                   | `createMcpHandler` with `legacy: 'stateless' \| 'reject'`, `McpServerFactory`, `McpRequestContext`, `AuthInfo`, `requireBearerAuth`, `bearerAuthChallengeResponse`, `validateHostHeader`/`validateOriginHeader`, `WebStandardStreamableHTTPServerTransport`, `LATEST_PROTOCOL_VERSION`                                                                                                                                                                                                                                                                                                          |
| `@modelcontextprotocol/client` | 2.3.1                   | `ClientOptions.versionNegotiation` with modern `mode: { pin: '2026-07-28' }` (explicit; the v2 client defaults to legacy negotiation)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@modelcontextprotocol/node`   | 2.1.1                   | `toNodeHandler` (fetch-shaped handler → Node req/res)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `express` / `kysely` / `pg`    | 5.3.0 / 0.29.6 / 8.23.1 | express integration target; Kysely required by the A2A database store; existing driver reused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Critical ordering fact (drives the adapter design).** In `DefaultRequestHandler.sendMessage`,
a NEW task is _not_ persisted before work starts: `_createRequestContext` only
loads/updates history for continuations, then `_runExecutor` calls
`agentExecutor.execute(...)`, and the first `taskStore.save(...)` happens inside
`ResultManager` when the executor publishes its first event. A crash between
message receipt and that first event would therefore leave no durable task.

### Admission design (commit canonical task + mapping before work)

`packages/protocols/src/a2a/message-admission.ts` wraps the official handler with
an admission step that runs **before** `handler.sendMessage/sendMessageStream`:

1. Authenticate the service identity (bearer) and validate the request envelope.
2. Open ONE Kysely transaction and lock `(agentIdentity, messageId)` in
   `odft_protocol.inbound_messages`:
   - absent → insert claim + canonical `Task` (state `SUBMITTED`, empty history —
     the handler appends the incoming message — and empty artifacts) via the
     **official** `DatabaseTaskStore` constructed on the transaction handle, +
     mapping row (`message_id → task_id`, `context_id`, `payload_hash`) → commit
     → hand the canonical `taskId` to the handler (which then loads it and runs
     the executor). A message that already carries a `taskId` is a continuation:
     the existing task is never rewritten, only mapped.
   - same `payload_hash` → replay: skip execution, return/retrieve the canonical
     task (completed duplicates return the persisted result).
   - different hash for an existing `messageId` → safe conflict
     (`TASK_MESSAGE_CONFLICT` mapped through the error envelope), no work.
3. Reconciliation on startup (under the per-identity service lock): a task left
   `submitted`/`working` by a stopped process is finalized as
   `FAILED`/`AGENT_RESTARTED` before any duplicate can be admitted; an active
   duplicate attaches to the canonical task instead of starting a second
   computation, and `input_required` is left untouched (waiting on the
   traveler, not on the process).
4. The executor always publishes the initial task/message event (also on
   continuation), then working/progress/artifact/status events — all official
   SDK event-bus behavior; the adapter never replaces wire processing,
   serialization, lifecycle events, client calls or streaming.

Transactions only touch the protocol tables (SDK task table + dedup/mapping),
never domain tables; all HTTP/executor work stays outside transactions. Table
name is configured to the SQL generated offline by `a2a-db upgrade --sql
--dialect postgres --store tasks --tasks-table-name …` and reviewed into the
migration.

## 3. Exact implementation plan

### 3.1 `packages/contracts` (SDK-independent Zod)

- Add `agent-artifacts.ts`: correlation envelope (schemaVersion 1, skillId,
  tripId, operationId, acceptedRevision, delegationId, traceId, snapshotId +
  scenario key, fingerprints, payload hash), the five v1 artifact schemas
  (`FlightRecommendationsV1`, `AccommodationRecommendationsV1`,
  `CityGuideRecommendationsV1`, `ItineraryProposalV1`, `AgentInputRequestV1`)
  with their versioned media types.
- Add `agent-tasks.ts`: task request binding (§3.5 fields), continuation
  message binding (same task/context, input generation), cumulative task limits
  and deadline fields.
- Add `coordinator.ts`: typed steps, wait reasons, run cursor schema
  (schema-versioned minimal execution data), decision binding union
  (graph vs coordinator-run), delegation/outbox status enums.
- Add `protocol-observations.ts`: safe observation kinds, source identity,
  correlation fields, sanitized payload, occurrence time.
- Adapt `enums.ts` (engine enum `langgraph | coordinator-v1`; delegation/task
  safe statuses; decision kind `agent_input`; the ten safe application error
  categories), `decisions.ts` (engine-discriminated binding schema,
  `agent_input` payload: request/option IDs, hash, expiry), `operations.ts`
  (engine field), `errors.ts` (map the ten safe categories onto existing error
  envelope codes), `projection.ts` (additive engine field only — no behavior
  change), `inspector.ts` (safe task/observation DTOs), `index.ts` exports.

### 3.2 `packages/protocols` (new, official SDKs only)

- `config.ts` — protocol service config from env (origins, bearer token refs,
  timeouts 3 s card / 5 s call, capability cache 5 min), no secrets in code.
- `auth.ts` — bearer verification with timing-safe compare, service identity
  extraction, safe failures; never trusts caller-supplied JSON identity.
- `telemetry.ts` — sanitized observation records (no prompts/tokens/stacks).
- `a2a/registry.ts` — trusted card registry (allowed card URLs, credentials
  refs, exact origins, required skills); validate the whole advertised
  interface, reject redirects/arbitrary discovery.
- `a2a/client.ts` — `ClientFactory` + `JsonRpcTransportFactory` wrapper: card
  discovery with 3 s timeout, 5-minute cache, origin pinning, modern JSON-RPC
  over HTTP, SSE streaming; SDK-independent safe errors.
- `a2a/server.ts` — `AgentCard` + `DefaultRequestHandler` + express
  `agentCardHandler`/`jsonRpcHandler` construction for test servers/agents.
- `a2a/task-store.ts` — factory for the official `DatabaseTaskStore` over a
  schema-qualified Kysely/PostgreSQL connection (per-agent task table).
- `a2a/message-admission.ts` — the transactional admission/replay/conflict
  layer of section 2.
- `mcp/client.ts` — modern pinned client connect/discovery/tool-call/resource
  read with 5 s deadlines and one bounded read-only retry.
- `mcp/server.ts` — `createMcpHandler({ legacy: 'reject' })` + Node
  `toNodeHandler`, auth before dispatch via `authInfo`, host/origin validation.
- `index.ts` — exports; no LangGraph/DB-client leakage into browser bundles.

### 3.3 `packages/persistence`

- Migration `0013-protocol-state.sql` (checksummed, append-only):
  - `trips`/`workflow_operations`: `engine text NOT NULL DEFAULT 'langgraph'`
    - archive/history metadata columns (unused/default until Phase 11).
  - `pending_decisions`: engine column; nullable `thread_id`/`graph_version`
    for coordinator decisions; kind + `agent_input`; engine-specific check
    constraint (graph rows require thread/graph fields, coordinator rows
    require a coordinator-run binding).
  - New `odft_app.coordinator_runs`, `odft_app.agent_delegations`, outbound
    message records (unique message id + payload hash, immutable serialized
    payload, delivery state, continuation generation), inbound
    dedup/mapping/task-control/counters, `odft_app.protocol_observations`
    (+ unique observation→application-event link).
  - `odft_protocol` schema with the official per-agent task tables from the
    reviewed `a2a-db` SQL (Flight, Accommodation A/B, City Guide).
  - Indexes for outstanding delegations, revoked/cancel-pending tasks, task
    ownership, operation correlation, un-ingested observations.
- New repositories: `coordinator-runs.ts`, `agent-delegations.ts`,
  `protocol-tasks.ts`, `protocol-observations.ts` (transaction/fence ownership
  explicit); adapt `decisions.ts` (engine binding), `migrate.ts`
  (`MIGRATION_VERSIONS` + `0013`), `index.ts`, engine fields in
  admission/trip/operation repositories.
- `tests/unit/migration-manifest.test.ts` updated for `0013`.

### 3.4 Scripts, fixtures, docs, wiring

- `scripts/setup-protocol-roles.ts` — idempotent role/grants setup (base
  read-only MCP access, protocol schema access); passwords from env, never
  committed.
- `agent-registry.example.json` — trusted registry example (no secrets).
- `tests/fixtures/protocols/{a2a-echo,mcp-echo}.ts` — minimal real SDK-backed
  services for interoperability tests.
- `tests/unit/protocols/contracts.test.ts` — schema + semantic envelope
  validation (media types, versioning, unknown-field rejection).
- `tests/integration/protocols/sdk-interoperability.test.ts` — real HTTP:
  A2A card discovery → task send → stream progress/artifact/status →
  retrieve → persisted result after server restart; duplicate send replay;
  conflicting payload rejection; MCP modern negotiation (pinned version),
  tool call, resource read, legacy/mismatched negotiation rejection,
  unauthorized request rejection.
- `tests/integration/protocols/persistence.test.ts` — migration repeatability,
  admission transactionality, crash-between-admission-and-work reconciliation,
  task survives store reload.
- `docs/protocols/contracts.md` — actual SDK shapes, initial-event
  requirements, restart limitations, error mapping.
- Build/workspace: root `package.json` workspaces + scripts, `tsconfig.build.json`,
  `scripts/verify-build.ts`, `.env.example` (endpoint URLs, timeouts, token
  refs), lockfile.

## 4. Validation approach

1. Install pinned versions (Node 24 via nvm) → lockfile committed.
2. `a2a-db upgrade --sql …` reviewed → SQL folded into `0013`; migration applied
   twice (repeatability) + manifest test.
3. Real official-client tests over HTTP for both SDKs (no fake SDK, no
   in-process-only protocol test): the A2A echo fixture and MCP echo fixture
   live in separate processes.
4. Crash-window test: kill the fixture between admission commit and first work;
   reconciliation must finalize it and a duplicate must not start new work.
5. Dedupe: same message ID + same payload → one execution; same ID + different
   payload → safe conflict; concurrent duplicates → one canonical task.
6. Auth: missing/invalid bearer → predictable rejection; legacy MCP negotiation
   → rejected with unsupported-protocol-version; unauthorized MCP request →
   rejected before dispatch.
7. Regression: full unit + integration suites, typecheck/lint, production
   build + bundle verification (browser contracts must not import SDKs), graph
   smoke E2E (scaffold + wizard-flights isolated) and the benchmark smoke to
   prove the old application still starts and executes normally.
8. No paid calls anywhere (fixture AI only).

## 5. Risks and mitigations

- **SDK SQL drift**: generate SQL with the pinned CLI and commit it; integration
  tests fail if the store's expectations drift.
- **Crash window**: admission pre-commits task+mapping in one transaction;
  reconciliation test proves it.
- **Mixing A2A 0.3/1.0 shapes**: only 1.0 declarations used; no v0.3 imports.
- **MCP negotiation**: client pinned to `2026-07-28`; tests assert the
  negotiated version and that legacy is rejected.
- **Schema scope creep**: contracts limited to §3.5 + minimal engine binding;
  no coordinator/agent business logic in this phase.
- **Browser leakage**: bundle verification + no SDK imports outside
  `packages/protocols`/server code.

## 6. Acceptance mapping

- Actual selected SDKs communicate over HTTP → integration tests with real
  clients (section 4.3).
- Tasks survive storage reload → restart test.
- Duplicate messages cannot start duplicate work → dedupe/conflict/crash tests.
- Browser contracts contain no SDK/DB secrets → build/bundle verification.
- Old application still starts and executes normally → full regression gates +
  isolated E2E smoke + benchmark comparison.
