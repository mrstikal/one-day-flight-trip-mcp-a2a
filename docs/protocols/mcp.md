# MCP services (Phase 04; final Phase 12)

Three read-only MCP endpoints expose the existing reference, scenario and
itinerary-math capabilities over real Streamable HTTP. They own no trip
progression, no scenario materialization, no reservations and no LLM reasoning;
every tool call is a parameterized query against a frozen snapshot or the
reference data.

The development defaults are ports `4321-4323`. The isolated test/E2E/benchmark
stack starts the same host on `4421-4423` so it cannot collide with a running
development stack; only the ports differ, never the endpoints or contracts.

## Endpoints and identities

| Endpoint               | Identity               | Port (default) | Tools                                                                                                                                                           | Authorized callers                                                                                                                                                                                                                    |
| ---------------------- | ---------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/geography/mcp`       | `odft-geography`       | 4321           | `search_countries`, `search_cities`, `find_airports`, `get_city_details`, `get_airport_details`, `get_city_airports`, `estimate_distance`, `validate_air_route` | all three agent identities; the route tool additionally requires a non-revoked delegation with the route scope                                                                                                                        |
| `/travel-data/mcp`     | `odft-travel-data`     | 4322           | `search_flights`, `search_hotels`, `search_restaurants`, `search_attractions`, `search_events`, `get_scenario_metadata`                                         | per-identity domain allowlist: Flight → flights/metadata, Accommodation → hotels/metadata, City Guide → meals/activities/events/metadata; **every** tool (metadata included) requires a non-revoked delegation for the exact snapshot |
| `/itinerary-tools/mcp` | `odft-itinerary-tools` | 4323           | `estimate_travel_time`, `validate_itinerary`, `calculate_trip_cost`                                                                                             | City Guide only (itinerary scope)                                                                                                                                                                                                     |

Resources: `odft://geography/coverage`, `odft://geography/licenses`,
`odft://scenario/{snapshotId}/manifest` (template, delegation-scoped) and
`odft://itinerary/pace-profiles` (versioned `pace-v1`). No MCP prompts are
registered: reusable planning prompts live with the governed AI roles.

## Authorization model

1. Every request is authenticated with a registry bearer token; the identity is
   taken from the token, never from the request body.
2. The endpoint factory enforces the endpoint allowlist before registering any
   tool and binds the authenticated identity to a fresh `McpServer` instance per
   request, so tools can never act for another caller; a disallowed identity
   cannot even complete discovery.
3. Scenario tools (including `get_scenario_metadata`) take `delegationId` + the
   explicitly authorized `snapshotId`.
   `agent_delegations` must be non-revoked, belong to the caller, be within its
   deadline, include the requested domain and match the exact frozen snapshot.
   The active trip pointer (`trips.active_scenario_snapshot_id`) is never read.
4. The manifest resource uses the same check (an active delegation of the caller
   for exactly that snapshot).
5. Two database roles keep least privilege: `ODFT_PROTOCOL_DATABASE_URL` (the
   protocol role) serves delegation authorization reads and sanitized
   observations — falling back to `DATABASE_URL` only when unset; the read-only
   role (`odft_mcp_readonly`) reads reference tables, `scenario_snapshots`,
   `route_validations`, `schedule_validations`, `trips`, `simulation_faults`
   and `reference_route_evidence` and has **no write grant** (proven by test).

## Read-only guarantees

- Frozen-snapshot queries (`createTravelSnapshotReadService`) reuse the existing
  providers and filters; they never resolve the active snapshot pointer and
  never write recommendation artifacts or fault counters.
- `search_flights` returns only combinations the persisted Stage B validation
  accepted (the route approval alone is not a schedule guarantee) and reports
  the flight domain hash from the manifest.
- A resolved fault overlay is injected into every provider read that supports
  simulated outcomes (`flights`, `hotels`, meals — the same providers the
  research path uses; `attractions`/`events` are plain reads), so a simulated
  outage returns a tagged `unavailable` outcome with a safe reason — the
  coordinator (not the MCP endpoint) records the idempotent fault outcome.
- Itinerary tools reuse the routing, assembly, validation, metrics and cost
  functions; every referenced candidate is validated against the snapshot
  (invented ids are rejected with `INVALID_ARGUMENT`) and nothing is persisted.
- Repeated identical reads return identical results and change no row
  (asserted: snapshots, artifacts, reservations and fault counters are
  unchanged).

## Protocol behavior

- Modern-only: `createMcpHandler({ legacy: "reject" })`; the pinned client
  negotiates `2026-07-28`. Host and Origin headers are validated before the
  auth check; unauthenticated requests get `401` with `WWW-Authenticate` and
  never reach a tool.
- Five-second deadlines cover the connect handshake and every call; the one
  bounded retry applies only to eligible transport failures on read-only
  resource reads (never to permission denials or timeouts). Each agent process
  keeps one cached connection per trusted endpoint (reused across calls); a
  failed handshake closes its transport. Each real invocation is recorded as one
  sanitized observation (tool name, duration, safe outcome; no arguments,
  results or credentials). The per-task invocation budget is reserved with an
  atomic conditional UPDATE before the call, so concurrent callers cannot
  exceed it; a failed or timed-out attempt still consumes its reservation
  ("invocations including retries").
- `/health` on each endpoint answers a static payload and performs no database,
  provider or external request.

## Running the host

```bash
# One-time: create the protocol and read-only roles (passwords from the env).
npm run protocol:roles

# Start the three endpoints (uses .env, registry file, ports 4321-4323).
npm run dev:mcp        # development (tsx watch)
npm run build:mcp      # compile to apps/mcp-server/dist
node apps/mcp-server/dist/main.js

# Health
curl http://127.0.0.1:4321/health
```

Environment: `ODFT_MCP_AGENT_REGISTRY_PATH` (trusted inbound identities, see
`tests/fixtures/protocols/mcp-host-registry.json`), `ODFT_MCP_READONLY_DATABASE_URL`,
`ODFT_MCP_HOST`, `ODFT_MCP_{GEOGRAPHY,TRAVEL_DATA,ITINERARY_TOOLS}_PORT`, and the
agent bearer tokens referenced by the registry credential refs. No secrets are
committed.

## Tests

`tests/integration/mcp/{discovery,geography,travel-data,itinerary-tools,authorization}.test.ts`
spawn the real host, seed a frozen snapshot through the real worker harness, and
drive official MCP clients over HTTP: inventory and negotiation, deterministic
reference/route results (including the PRG → České Budějovice Stage A
rejection), domain-scoped candidate facts, provider-fault handling (hotels and
flights), membership rejection, the delegation-scoped manifest resource
(including revocation), identity/endpoint/delegation/snapshot/deadline/revocation
denials, host/origin rejection, unavailable-endpoint timeouts, observation
sanitization, all-pages schedule-valid enforcement and the read-only role's
write denial.

The final Phase 12 gate re-ran this suite as part of 50 integration files / 275
tests (all passing); see
[`docs/planning/migration-results.md`](../planning/migration-results.md).
