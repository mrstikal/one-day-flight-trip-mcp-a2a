# Protocol contracts (Phase 03)

SDK-independent contracts and the official A2A/MCP integration of the ODFT
worker. Everything here was verified against the pinned packages
(`@a2a-js/sdk@1.3.0`, `@modelcontextprotocol/{server,client}@2.3.1`,
`@modelcontextprotocol/node@2.1.1`, `express@5.3.0`, `kysely@0.29.6`).

## 1. Where things live

| Concern | Location |
| --- | --- |
| Artifact/envelope/task/observation contracts | `packages/contracts/src/{agent-artifacts,agent-tasks,coordinator,protocol-observations}.ts` |
| Engine-aware decisions/operations | `packages/contracts/src/{decisions,operations,enums,errors}.ts` |
| Transport adapters, auth, registry, telemetry | `packages/protocols/src/**` |
| Protocol state (migration `0013`) | `packages/persistence/migrations/0013-protocol-state.sql` |
| Protocol repositories | `packages/persistence/src/{coordinator-runs,agent-delegations,protocol-tasks,protocol-observations}.ts` |
| Fixtures used by the interoperability tests | `tests/fixtures/protocols/{a2a-echo,mcp-echo}.ts` |

## 2. Artifact envelope (v1)

Every specialist artifact carries `artifactCorrelationSchema`: schemaVersion 1,
`skillId`, `tripId`, `operationId`, `acceptedRevision`, `delegationId`,
`traceId`, `snapshotId`, `scenarioKey`, `inputFingerprint` and per-domain
`domainFingerprints`. Business fingerprints never include task ids, transport
request ids, timestamps or trace ids — delivery metadata must not invalidate a
cached artifact.

Versioned media types:

| Artifact | Media type |
| --- | --- |
| Flight recommendations | `application/vnd.odft.flight-recommendations.v1+json` |
| Accommodation recommendations | `application/vnd.odft.accommodation-recommendations.v1+json` |
| City-guide recommendations | `application/vnd.odft.city-guide-recommendations.v1+json` |
| Itinerary proposal | `application/vnd.odft.itinerary-proposal.v1+json` |
| Input request | `application/vnd.odft.agent-input-request.v1+json` |

All schemas are strict: unknown fields are rejected before anything is
persisted, and ranked ids must reference existing offers/candidates.

## 3. Real A2A shapes (verified against the pinned SDK)

- **Card discovery** is pinned: exact origin, fixed card URL, no redirects, 3 s
  timeout, 5-minute cache; every advertised interface must stay on the trusted
  origin, and every required skill must be advertised.
- **Wire binding served**: the modern 1.0 JSON-RPC binding only —
  `method: "SendMessage" | "SendStreamingMessage"` with `params.message` and an
  explicit 1.x `A2A-Version` header. The SDK's HTTP+JSON `/v1/...` routes live in
  `restHandler`, which this server does NOT mount, and legacy 0.3-shaped requests
  are rejected (`legacyCompat` stays disabled); admission therefore claims only
  messages the served binding will actually process.
- **Every executor invocation must publish the task (or a message) first** —
  the SDK rejects streams that start with a status/artifact update, including
  continuations.
- **Input-required continuation**: the task stays the same; the follow-up
  message carries `taskId`/`contextId`, the SDK appends it to the task history,
  and the admission layer never rewrites the existing task row (history,
  artifacts and the SDK's terminal-state/context guards stay authoritative).
- **Task states** are the SDK's numeric enum (`SUBMITTED=1`, `WORKING=2`,
  `COMPLETED=3`, `FAILED=4`, `INPUT_REQUIRED=6`, …).
- **Task storage** is the official `DatabaseTaskStore` over a schema-qualified
  Kysely instance (`odft_protocol.agent_tasks_*`, SQL generated offline with
  `a2a-db upgrade --sql --dialect postgres --store tasks`). The SDK's migration
  ledgers are kept in step so `a2a-db status` stays accurate, but the schema is
  owned by the checksummed application migration — never by an untracked
  startup upgrade.

### Durable admission (crash window)

`DefaultRequestHandler` persists a NEW task only when the executor publishes its
first event. The admission middleware closes that window **before** the handler
runs, in ONE transaction:

1. claim `(agentIdentity, messageId)` in `odft_app.protocol_inbound_messages`
   (payload hash checked),
2. write the canonical task through the official store on the same
   transaction,
3. record the message→task mapping and the `submitted` task-control row,
4. commit, then rewrite the message's `taskId` so the handler continues on the
   canonical task.

Outcomes: same message id + same payload → **replay** (the persisted task is
returned; no new work, including on the streaming binding, where the replay is a
proper JSON-RPC SSE frame); same id + different payload → **safe conflict**
(HTTP 409, nothing runs). A continuation (message with an existing `taskId`)
maps the message to the existing task and reopens its task-control row instead of
writing a task.

Restart safety: each service process holds a PostgreSQL session advisory lock per
agent identity (`ServiceInstanceLock`); a second live process fails fast, and
only the lock holder may reconcile. Reconciliation marks tasks left
`submitted`/`working` as explicit `FAILED`/AGENT_RESTARTED results (SDK row +
control row) before any duplicate may be admitted; `input_required` is a resting
state and is never turned into a failure.

## 4. MCP (modern-only)

- Server: `createMcpHandler(factory, { legacy: "reject" })` + Node
  `toNodeHandler`, with an upstream `express.json()` body forwarded as
  `parsedBody` (the adapter must never re-read a consumed stream).
- Middleware order: host/origin validation → bearer verification →
  adapter. Authentication runs before dispatch: unauthenticated requests get
  `401` + `WWW-Authenticate` and never construct a server instance.
- Client: pinned modern negotiation
  (`versionNegotiation: { mode: { pin: "2026-07-28" } }`), explicit deadlines,
  one bounded retry for read-only resource reads only.
- 2025-era clients are rejected with the SDK's unsupported-protocol-version
  error (asserted by the interoperability test).

## 5. Auth, registry, telemetry

- Bearer tokens are resolved from the environment through registry
  `credentialRef`s; nothing is committed. Comparison is timing-safe and
  failures are uniform. The authenticated identity always comes from the token,
  never from the request body.
- Only registry agents are reachable; endpoints are pinned to an exact origin.
- Observations (`odft_app.protocol_observations`) are append-only safe records:
  bounded codes/counters only, sanitized one-line details, no prompts, tokens,
  credentials or provider payloads. The optional unique link to an execution
  event makes SSE ingestion idempotent (Phase 09).

## 6. Engine identity

`trips`/`workflow_operations`/`pending_decisions` carry `engine`
(`langgraph` default, `coordinator-v1`). Coordinator decisions bind
`coordinator_run_id` and must NOT carry graph checkpoint ids; graph decisions
require `thread_id` + `graph_version` and must not bind a run (enforced by
`pending_decisions_engine_binding_check` and by the Zod contract). Existing
records and the production default engine are unchanged by Phase 03.

## 7. Running the checks

```bash
npm run test:unit                                     # contracts + boundary tests
npx vitest run --project integration tests/integration/protocols   # real HTTP SDK tests
npm run protocol:roles                                # optional role setup (env passwords)
```
