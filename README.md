# AI Travel Planner

A hybrid graphical/conversational planner for one sightseeing day in a European city.

> **Sibling project.** This project was created as a sibling of the LangGraph demo:
> https://github.com/mrstikal/one-day-flight-trip-langgraph — the same assignment, but with
> different target technologies.

**DEMO APPLICATION - No real reservations are made and no payments are processed.**

## What This Demo Demonstrates as a Proof of Concept

The goal is a **stateful, human-in-the-loop AI workflow**, not a production travel agency or an
autonomous booking agent.

The active runtime is a **coordinator** that admits durable operations, routes them through an
explicit state machine, and delegates research and itinerary work to independent **A2A agents** over
a trusted protocol. The agents read geography, travel-data, and itinerary-tool capabilities from a
read-only **MCP host**. Every user decision is persisted; an operation can resume after a worker
restart from its durable operation/decision rows instead of an in-process graph checkpoint. This
makes a multi-step process explicit, testable, and observable instead of hiding it inside one large
prompt.

### Why MCP and A2A?

The demo deliberately uses two open protocols instead of one monolithic prompt or a pile of
service-specific adapters. They solve different problems and complement each other:

| Protocol                         | What it is                                                                                                                                                         | Role in this demo                                                                                                                                                              | Why it helps                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP (Model Context Protocol)** | An open protocol for exposing tools, resources and prompts to AI applications through a standard client/server contract.                                           | A read-only MCP host publishes three capability endpoints: `geography`, `travel-data` and `itinerary-tools`. Agents discover and call those capabilities over Streamable HTTP. | Standard discovery and invocation instead of bespoke tool glue; one capability can serve several agents; least-privilege read-only boundaries; replaceable implementations; bounded, auditable calls; no agent needs direct SQL or ownership of business state.                                 |
| **A2A (Agent2Agent)**            | An open protocol for discovering agents and delegating tasks to them, with a real task lifecycle, streaming updates, artifacts and `input-required` continuations. | The coordinator delegates flight, hotel/meal and city-guide research to independent A2A services, each publishing an Agent Card and returning a versioned artifact.            | Loose coupling and independent deployment or replacement; specialist autonomy behind a stable contract; parallel research; explicit task state and provenance; real retry, cancel and recovery semantics; one agent can be swapped through the registry without changing the coordinator or UI. |

MCP answers "what capabilities can an agent use?" while A2A answers "which specialist should do this
piece of work, and how do we track it?". Keeping the two separate means the coordinator owns business
rules, feasibility, booking and publication; agents own research and proposals; MCP services own
read-only reference and scenario data. The result is easier to test, observe and secure than a single
agent with unrestricted tools, and it avoids duplicating business rules in every specialist.

Both are real network protocols here: the official A2A and MCP SDKs run over HTTP between separate
processes, not as local function wrappers pretending to be a protocol. That is what makes the
delegation, discovery, streaming, `input-required`, cancellation and recovery behavior testable at
the protocol boundary.

The trade-off is operational: more processes and network hops, explicit identity and registry
configuration, and protocol-level failure handling. The demo keeps that visible (trusted local
registry, bearer identity, delegation-scoped reads, fixture mode) instead of hiding it behind a
framework. See [the MCP contract](docs/protocols/mcp.md),
[the agent contract](docs/protocols/agents.md) and
[the coordinator design](docs/architecture/coordinator.md).

This demo applies those capabilities to:

- **Hybrid interaction:** graphical controls and chat use the same validated commands and business
  rules; ambiguous or conflicting requests produce bounded clarification choices.
- **Parallel research:** the Accommodation Agent researches hotel and meals while the City Guide
  Agent researches attractions and events; only failed or affected domains need another search.
- **Controlled planning:** the City Guide Agent proposes a day, deterministic validation checks it,
  and a reviewer assesses qualitative tradeoffs, with at most three planning attempts before user
  input.
- **Selective changes:** cheaper-hotel searches, local service-level overrides, or a less demanding
  pace refresh the relevant results without silently replacing unrelated confirmed reservations.
- **Durability and visibility:** saved operations, decisions, delegations, and events support
  reload/recovery; an execution inspector exposes the A2A/MCP communication map, attempts, AI
  usage/costs, and labeled simulated faults, not private model reasoning or secrets. SQL
  transactions, leases/fencing, and idempotent effects prevent duplicate simulated bookings on
  replay.

### Supporting Technologies and AI

| Technology                     | Role in the demo                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js / TypeScript / Zod     | Server runtime, typed domain contracts, and strict validation of requests and model outputs.                                                                                                  |
| Next.js / React / Tailwind CSS | Graphical wizard, assistant, and presentation; Next.js also acts as the backend-for-frontend (BFF).                                                                                           |
| Dedicated worker / PostgreSQL  | The worker executes the coordinator outside browser requests; PostgreSQL stores domain truth, queued operations, decisions, events, AI cost records, and protocol evidence.                   |
| A2A agents / MCP host          | Flight, Accommodation, and City Guide agents own specialist research/planning; a read-only MCP host exposes geography, travel-data, and itinerary tools with per-agent identities and tokens. |
| OpenRouter / AI adapters       | Configurable model access for four roles: intent interpretation, optional recommendation ranking, itinerary planning, and qualitative review.                                                 |
| Faker / Temporal               | Seeded fictional labels and variation; correct calendar, time-zone, DST, and elapsed-time handling. Domain algorithms, not Faker or AI, own scheduling and pricing.                           |
| Leaflet / SSE                  | Map presentation with a schematic fallback; Server-Sent Events deliver persisted workflow progress to the browser.                                                                            |

AI returns structured **proposals**, never authoritative prices, feasibility decisions, or booking
permissions. Existing candidate IDs and deterministic rules constrain every result. Direct graphical
actions do not need an intent-model call, and explicit user confirmation remains mandatory for
simulated bookings, replacements, impactful route changes, and itinerary approval.

## How the Demo Works

1. **Describe the trip.** Choose an origin airport (PRG by default), supported European country/city,
   sightseeing date, adults, and one or two hotel nights. Budget/Standard/Luxury defaults can be
   overridden per hotel or meal; pace, interests, numeric activity requirements, and budget are
   separate preferences.
2. **Check the journey before offering flights.** Deterministic Stage A checks practical route and
   airport eligibility, including when ground travel is more practical. Only approved routes receive
   synthetic flights; independent Stage B checks
   dates, connections, arrival/return windows, transfers, and enough time for a full sightseeing day.
   Arrival is on the previous day; return is late on the sightseeing day or the following day.
   Unsupported routes or impossible schedules stop downstream work rather than inventing a solution.
3. **Choose services and a program.** Review and explicitly confirm demo flights, then research hotel,
   meals, attractions, and events in parallel. Select and confirm a hotel, choose meals and preferred
   activities, and optionally simulate restaurant reservations. The one-night variant requires
   luggage storage; a return window that leaves no dinner slot is explained explicitly.
4. **Build and approve the day.** Assemble a timeline with visits, meals, breaks, transfers, and airport
   buffers. Deterministic checks cover overlaps, simulated opening windows, walking/pace, fixed
   reservations, activity counts, and budget. Planner/reviewer feedback can revise the draft; unresolved
   conflicts require a user decision. A map, validation messages, and a party-total EUR breakdown
   accompany the itinerary; approving it is separate from booking anything.
   Saving meal choices accepts the request asynchronously, then shows when the choices are persisted,
   the itinerary is being built, and the draft is being reviewed inside a blocking full-screen preloader.
   Navigation and controls stay unavailable until the operation settles. Visits are opt-in, so an otherwise
   valid day without selected or required activities is not repeatedly replanned to fill free time.
   Stylistic advice is shown as warnings; only actionable structural feedback triggers another attempt,
   and identical feedback on unchanged structure stops early.
5. **Revise and observe.** Chat or supported controls can change preferences, search alternatives, or
   rebuild the relevant part of the plan. Confirmed services remain fixed until an explicit replacement
   or route-impact confirmation. Persisted decisions survive browser closure, and operation/effect
   recovery supports worker restart. Protected demo controls and the inspector demonstrate unavailable
   offers, provider failures, invalid drafts, and budget/preference conflicts with visible labels.

### Data, Fakes, and Real Computation

| Layer                      | What is real and what is simulated                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geographic references      | Versioned offline GeoNames countries/cities (`cities15000` coverage), OurAirports airports/codes/coordinates, reviewed Wikidata landmarks, and resolved IANA time zones. Assets are loaded into PostgreSQL; normal startup does not download them. Rome, Paris, and Barcelona have richer curated coverage; other supported cities use labeled generic activities.                     |
| Mock/fake travel providers | Synthetic providers read reproducible, seeded, persisted offer snapshots, not commercial APIs. Carriers, flight schedules, hotel/restaurant businesses, availability, ratings, events, prices, and opening hours are demo data. Hotel/restaurant pins are approximate positions, not real business addresses. Fault overlays change behavior without regenerating unrelated inventory. |
| Actual calculations        | Code really computes geographic distances, rule-based travel/transfer estimates, time-zone/DST conversions, feasibility, schedule constraints, pace metrics, and integer-cent party totals without double-counting. These calculations operate on demo assumptions, not live timetables, road routing, fares, or real availability.                                                    |
| AI modes                   | Default `fixture` mode replaces model calls with deterministic scripted interpretations/plans/reviews: no AI credentials, OpenRouter requests, or billable usage. `openrouter` mode makes genuine configured model calls with structured-output validation and call/token/time/cost limits; the travel data remains synthetic in either mode.                                          |
| Reservations and maps      | Confirmations create only internal `DEMO-*` records, never tickets, real reservations, or payments. Optional map tiles are external imagery, not a routing service; without usable tiles, a labeled SVG schematic and textual facts remain available.                                                                                                                                  |

The plan and detailed contracts are in [ODFT_PLAN.md](ODFT_PLAN.md) and
[docs/planning](docs/planning/00-project-overview.md). The planning documents that describe the
retired LangGraph runtime (notably [03-langgraph-design.md](docs/planning/03-langgraph-design.md))
are retained as historical design material; the active coordinator is specified by
[ODFT_PLAN.md](ODTF_PLAN.md) phases 07-11. See also
[reference data and generators](docs/planning/05-synthetic-data-design.md),
[AI roles](docs/planning/06-ai-agent-design.md),
[final migration results](docs/planning/migration-results.md) and the
[MCPA2A architecture decisions](docs/planning/decisions/MCPA2A-001-a2a-sdk.md).

**Demo limitations:** Broader application performance tuning and responsive-design validation
remain future tasks. This is not a production-ready
booking system, and its schedules, estimates, and confirmations are not valid for real travel.

## Inspector

The **Inspector** is the demo's workflow observability panel: it explains what the coordinator and
its specialist agents actually executed, where it is waiting, and why a retry or replan happened. Enable
`DEMO_CONTROLS_ENABLED=true` in the server environment, then open the trip's Inspector link or
`/trips/<trip-id>/inspector`. Access requires the browser session that owns the trip; a trip ID alone
does not grant access.

- **Communication map:** one safe row per A2A delegation/task and MCP call, with agent identities,
  task lifecycle states, correlation IDs, and durations derived from persisted protocol observations.
- **Application timeline:** a chronological A2A/MCP/application view that makes delegation, tool use,
  retries, and cancellations observable without exposing payloads or reasoning.
- **Operations and recovery:** attempts, execution durations, decision kinds, and resume operations
  help trace pauses, selective replanning, and restart recovery. Updates arrive through SSE, with
  polling fallback when the connection is unavailable. Legacy LangGraph trips keep their inert
  node/checkpoint history read-only.
- **AI telemetry:** role, model, prompt-version identifier, token usage, latency, cost/validation
  status, and retries distinguish model work from deterministic steps. Fixture invocations remain
  explicitly scripted and are not presented as live AI usage or billable calls.
- **Simulation controls:** protected commands activate persisted no-flight/no-hotel, provider-error,
  invalid-itinerary, and budget/preference-conflict modes. Injected faults are labeled
  `Simulated failure`; they change provider/validator behavior without regenerating unrelated offers.
- **What to observe:** a failed hotel branch retrying while successful meal/activity results remain,
  a rejected draft entering the bounded planning loop, or a pace/dinner change rerunning only the
  relevant work while confirmed services stay intact.

The Inspector renders only safe projected data, not raw protocol payloads or database dumps. It never exposes
prompt text, raw model output, private reasoning/chain-of-thought, provider payloads, SQL, stack
traces, cookies, or secrets. Simulation commands use the normal validated command path, not arbitrary
coordinator edits; worker/database restarts remain operator actions, never browser-executed shell
commands.
See the [Inspector specification](docs/planning/08-frontend-ux.md#10-inspector).

## Requirements

- Node.js 24 LTS (`>=24 <25`)
- npm 11+
- Docker + Docker Compose (local PostgreSQL 17)
- Playwright browsers for E2E (`npx playwright install chromium`)

## First-time setup

```bash
npm ci                     # reproducible install from the committed lockfile
npm run setup:env          # writes a git-ignored .env with random secrets
docker compose up -d postgres
npm run db:migrate         # applies SQL migrations (repeat-safe)
npm run reference:load     # upserts the committed offline reference assets
npm run protocol:roles     # creates restricted protocol/agent DB roles (needs passwords)
npm run setup:config       # copies all JSON config templates (never overwrites)
```

`npm run setup:config` copies every committed template to its runtime name:
`ai-profiles.json`, `voice-profiles.json`, `agent-registry.json`,
`mcp-registry.json`, `mcp-registry.accommodation.json`,
`mcp-registry.city-guide.json`, `mcp-registry.accommodation-alt.json` and
`mcp-host-registry.json`. Existing files are left unchanged, so the command is
safe to re-run after pulling new templates.

`npm run setup:env` generates `SESSION_HMAC_KEY`, `ODFT_PROTOCOL_ROLE_PASSWORD`,
`ODFT_MCP_READONLY_PASSWORD`, the three primary `ODFT_*_AGENT_PASSWORD` values,
`ODFT_ACCOMMODATION_ALT_AGENT_PASSWORD`, and every `ODFT_AGENT_TOKEN_*` /
`ODFT_COORDINATOR_TOKEN` value as distinct random secrets; you only need to set
them manually if you copy `.env.example` yourself. `npm run protocol:roles` needs
the five non-optional passwords (protocol, MCP read-only and the three primary
agents); `npm run dev` needs those plus `ODFT_COORDINATOR_TOKEN`, the three
primary agent tokens and the MCP registry paths documented in
[Configuration](#configuration). The registries contain identities and credential
references, never secrets. Each agent has its own MCP registry because it must
present its own token; sharing the flight registry makes the other specialists
authenticate as the flight agent and their MCP calls fail authorization.

`setup:env` never overwrites an existing `.env` and never prints the generated secret. Values in
`.env.example` are development placeholders, not production defaults.

## Offline reference data

Versioned geographic reference assets live in `data/reference/*.ndjson` with manifests, checksums,
and license texts in `data/manifests/`. They are imported once and committed; normal startup never
downloads reference data.

```bash
npm run reference:import -- --source all      # explicit maintenance; needs network
npm run reference:load                         # idempotent upsert into PostgreSQL
```

`reference:import` filters GeoNames/OurAirports/Wikidata to the explicit European admission manifest
(`data/reference/country-policy.json`), resolves airport IANA zones at import time with `geo-tz`
(reviewed overrides in `data/reference/airport-zone-overrides.json`), and writes a rejected-record
report per source. `reference:load` is safe to run repeatedly.

## Development

```bash
npm run dev
```

Runs the tracked development stack with shutdown forwarding: shared-package TypeScript watch,
Next.js dev server (`apps/web`), the MCP host (`apps/mcp-server`), the Flight/Accommodation/City
Guide A2A agents, and the coordinator worker (`apps/worker`). Each agent receives its own
restricted-role database URL; the worker receives the trusted agent registry. The worker exposes
**no public HTTP port**; it connects to PostgreSQL and writes a heartbeat every 10 seconds.

## Verification commands

```bash
npm run typecheck
npm run lint
npm run test:unit          # no services required
npm run test:integration   # requires PostgreSQL at TEST_DATABASE_URL
npm run build              # packages -> web -> worker -> post-build verification
npm run test:e2e           # Playwright against `next start` (fixture mode)
npm run benchmark:baseline # six cases x five repetitions on a disposable stack
npm run validate:models    # OpenRouter only: validates AI profiles and, if configured, voice profiles
```

CI order: `typecheck` -> `lint` -> `test:unit` -> `test:integration` -> `build` -> `test:e2e`.
The final Phase 12 gate result is 62 unit files / 532 tests, 50 integration files / 275
tests, 101 E2E tests (1 skipped) and a 25/30 benchmark; see
[docs/planning/migration-results.md](docs/planning/migration-results.md).

## Operations

### Processes and ports

`npm run dev` starts the complete development stack and forwards `Ctrl+C` to every
child. The coordinator worker has no public port; it claims queued operations from
PostgreSQL and writes a heartbeat every 10 seconds.

| Process               | Default address         | Purpose                                              |
| --------------------- | ----------------------- | ---------------------------------------------------- |
| Web                   | `http://127.0.0.1:3000` | Next.js BFF, wizard, inspector, SSE                  |
| MCP host              | `127.0.0.1:4321-4323`   | geography, travel-data and itinerary-tools endpoints |
| Flight agent          | `127.0.0.1:4401`        | flight recommendations                               |
| Accommodation agent   | `127.0.0.1:4402`        | hotel/meal recommendations                           |
| City Guide agent      | `127.0.0.1:4403`        | attractions/events research and itinerary proposals  |
| Accommodation agent B | `127.0.0.1:4404`        | independent replacement implementation               |
| Coordinator worker    | no port                 | durable operation execution                          |

Start/stop:

```bash
npm run dev                 # full stack, fixture AI by default
# Ctrl+C stops every child; then:
docker compose down         # preserves the database volume
```

### Roles, grants and migrations

```bash
docker compose up -d postgres
npm run db:migrate          # repeat-safe, checksummed migrations
npm run reference:load      # committed offline assets only
npm run protocol:roles      # restricted protocol/agent roles; passwords from .env
```

`protocol:roles` needs `ODFT_PROTOCOL_ROLE_PASSWORD`, `ODFT_MCP_READONLY_PASSWORD`
and the three `ODFT_*_AGENT_PASSWORD` values; `npm run dev` also needs the
`ODFT_AGENT_TOKEN_*` values. The agent roles have no write grants on
trip/scenario/reservation tables; the MCP read-only role has no write grants at all. Never point
`TEST_DATABASE_URL` or `DATABASE_URL` at a database you care about when running the destructive
suites.

### Registry swap (specialist replacement)

1. Start the replacement service (for example `accommodation-agent-alt` on port
   4404 with `ODFT_AGENT_TOKEN_ACCOMMODATION_ALT` and its own task table).
2. Replace the accommodation entry in `agent-registry.json` with the replacement
   identity/endpoint/skill, or put it first. The coordinator selects the first
   trusted entry advertising the required skill.
3. Restart the worker so the registry is re-read. Tasks already bound to the old
   agent keep their persisted endpoint/task id; new work goes to the replacement.

`agent-registry.example.json` contains both entries; the switched fixture used by
the replacement tests is `tests/fixtures/protocols/agent-registry-coordinator-alt.json`.

### Budget, cancellation, restart and recovery

- **Budget:** `MAX_LLM_CALLS_PER_TRIP` and `MAX_LLM_COST_USD_PER_TRIP` bound paid
  work; each specialist also has per-task call/token/USD limits. Unknown provider
  outcomes keep their reservation. Fixture mode is free and writes no billable rows.
- **Cancellation:** cancelling an operation rotates the fence, revokes outstanding
  delegations and records a remote-cancel intent in one commit. Late artifacts are
  rejected; a terminal task is never resurrected.
- **Restart:** stop and restart the worker or any agent independently. Operations
  are lease-based; a crashed operation is reclaimed and resumes from the persisted
  coordinator cursor. Agents reconcile interrupted tasks to `AGENT_RESTARTED`
  instead of pretending they finished.
- **Recovery:** an owner can retry a terminally failed operation; the same run
  reopens at `interpreting`, completed accepted siblings are reused, and only the
  failed scope is re-dispatched. `input_required` questions survive restarts.
- **History:** `/trips/<id>/history` is read-only for archived trips and never
  resumes work. Legacy graph rows, when present, are rendered as inert history.

### Isolated E2E and benchmark databases

The E2E helper and benchmark refuse to run against a non-`*_test` database and
start their own full stack. A typical disposable setup:

```bash
psql "$ADMIN_DATABASE_URL" -c 'CREATE DATABASE odft_e2e_test'
DATABASE_URL=postgres://.../odft_e2e_test npm run db:migrate
DATABASE_URL=postgres://.../odft_e2e_test npm run reference:load

DATABASE_URL=postgres://.../odft_e2e_test \
PUBLIC_BASE_URL=http://localhost:3100/ \
npx playwright test

DATABASE_URL=postgres://.../odft_phase12_test \
PUBLIC_BASE_URL=http://localhost:3100/ \
npm run benchmark:baseline -- --output .cache/benchmarks/coordinator-phase12.json
```

The benchmark owns ports `3100` and `4421-4423`/`4431-4434`; stop any leftover
test stack first. It resets the target schemas, so use a dedicated disposable
database.

## Configuration

All configuration is server-side and validated at startup (`parseServerConfig`). See `.env.example`
for the full list. Key values:

| Setting                                                | Rule                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                         | Required; never logged                                                                                                                                                                                                          |
| `TEST_DATABASE_URL`                                    | Required for `npm run test:integration`; must point at a disposable `*_test` database because the suite resets its schemas                                                                                                      |
| `PUBLIC_BASE_URL`                                      | Exact origin used by cookie/CSRF checks                                                                                                                                                                                         |
| `SESSION_HMAC_KEY`                                     | Required random server secret (>= 32 chars)                                                                                                                                                                                     |
| `ODFT_PROTOCOL_ROLE_PASSWORD`                          | Required before `npm run protocol:roles` and `npm run dev`; >= 16 chars. Password for the `odft_protocol_service` role (protocol tables, coordinator run/outbound writes). Never commit it.                                     |
| `ODFT_MCP_READONLY_PASSWORD`                           | Required before `npm run protocol:roles` and `npm run dev`; >= 16 chars. Password for the `odft_mcp_readonly` role used by the MCP host; read-only grants, no write access.                                                     |
| `ODFT_FLIGHT_AGENT_PASSWORD`                           | Required before `npm run protocol:roles` and `npm run dev`; >= 16 chars. Password for the `odft_flight_agent` role; `npm run dev` derives that agent's restricted `DATABASE_URL` from it.                                       |
| `ODFT_ACCOMMODATION_AGENT_PASSWORD`                    | Same as above for the `odft_accommodation_agent` role.                                                                                                                                                                          |
| `ODFT_CITY_GUIDE_AGENT_PASSWORD`                       | Same as above for the `odft_city_guide_agent` role.                                                                                                                                                                             |
| `ODFT_ACCOMMODATION_ALT_AGENT_PASSWORD`                | Optional; only for the replacement demo. Password for the `odft_accommodation_agent` role connection used by Accommodation Agent B on port 4404.                                                                                |
| `ODFT_AGENT_TOKEN_FLIGHT`                              | Required before `npm run dev`; bearer token referenced by the registries for the flight agent (inbound identity and outbound MCP calls). Registries contain only the `credentialRef` name, never the token.                     |
| `ODFT_AGENT_TOKEN_ACCOMMODATION`                       | Same as above for the accommodation agent.                                                                                                                                                                                      |
| `ODFT_AGENT_TOKEN_CITY_GUIDE`                          | Same as above for the city guide agent.                                                                                                                                                                                         |
| `ODFT_AGENT_TOKEN_ACCOMMODATION_ALT`                   | Optional; bearer token for Accommodation Agent B and the replacement demo.                                                                                                                                                      |
| `ODFT_COORDINATOR_TOKEN`                               | Required before `npm run dev`; distinct coordinator→agent bearer. Agents accept this coordinator identity in addition to their own token, so the coordinator never holds an agent's credential.                                 |
| `DEMO_CONTROLS_ENABLED`                                | `true` enables the Inspector and protected simulation controls for owned trips in a local/demo deployment                                                                                                                       |
| `WIKIDATA_DISCOVERY`                                   | Optional (`true`): on the first trip to a city without reviewed landmarks, curate its notable attractions from Wikidata once and store them in the reference tables (see "Reference landmarks"); default off, tests never fetch |
| `AI_MODE`                                              | `fixture` (default, no credentials) or `openrouter`                                                                                                                                                                             |
| `OPENROUTER_API_KEY`                                   | Required only in OpenRouter mode                                                                                                                                                                                                |
| `AI_CONFIG_PATH`                                       | Required only in OpenRouter mode; path to the role-profile JSON file (see below)                                                                                                                                                |
| `VOICE_ENABLED`                                        | `true` shows the voice controls in the assistant rail (default `false`); see "Voice control (optional)"                                                                                                                         |
| `VOICE_CONFIG_PATH`                                    | Required only for live voice; path to the speech-profile JSON file                                                                                                                                                              |
| `OPENROUTER_STT_API_KEY`                               | Required only for live speech-to-text; a **separate** OpenRouter key restricted to Groq — never the shared `OPENROUTER_API_KEY`                                                                                                 |
| `MAX_LLM_CALLS_PER_TRIP` / `MAX_LLM_COST_USD_PER_TRIP` | Bounded AI usage (defaults 40 calls / 1.00 USD)                                                                                                                                                                                 |
| `MAP_TILE_URL`                                         | Optional `{z}/{x}/{y}` tile URL template for the itinerary map; unset → labeled SVG fallback (see below)                                                                                                                        |

`npm run protocol:roles` creates or updates the restricted `odft_protocol_service`, `odft_mcp_readonly`,
`odft_flight_agent`, `odft_accommodation_agent` and `odft_city_guide_agent` roles, and requires the
five non-optional passwords above (each at least 16 characters). `npm run dev` derives each process's
restricted database URL from those passwords, so the agents and MCP host never use the owner
`DATABASE_URL`. The optional Accommodation Agent B password and token are needed only for the
replacement demo. The bearer tokens are referenced by `credentialRef` entries in
`agent-registry.json`, `mcp-registry.json` and `mcp-host-registry.json`; the registry files contain
the reference names, never the secret values. Keep `.env` out of version control.
`npm run setup:env` generates a distinct random value for every `replace-me` placeholder,
including `SESSION_HMAC_KEY` and all protocol passwords/tokens; it never prints them. If you copy
`.env.example` manually instead, generate long random values (for example `openssl rand -hex 32`)
yourself. `npm run setup:config` creates the runtime JSON files (AI/voice profiles and the
registry templates) from the committed examples and never overwrites existing files.

### Protocol stack: agents, MCP host and registries

`npm run dev` starts the MCP host and the three primary A2A agents and gives each child its own
environment. The settings below are either **required inputs** for `npm run dev`, values **derived**
for a child process, or **optional/test-only** switches. The same `DATABASE_URL` name means the owner
role in the web/worker process and the matching restricted role inside an agent process; never start
an agent with the owner URL.

**Required for `npm run dev`** (the registry files are copied by `npm run setup:config`):

| Variable                                     | Purpose                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ODFT_AGENT_REGISTRY_PATH`                   | Trusted A2A registry: identities, exact origins, pinned card URLs and `credentialRef` names. Read by the worker/coordinator and by each agent. Default: `agent-registry.json`.                                                             |
| `ODFT_MCP_AGENT_REGISTRY_PATH`               | Trusted inbound registry for the MCP host: which agent identities may call which endpoint. Required in normal development; `npm run dev` falls back to the protocol test fixture only when it is unset. Default: `mcp-host-registry.json`. |
| `ODFT_MCP_REGISTRY_PATH`                     | MCP endpoints and credential refs used by the flight agent. Default: `mcp-registry.json`.                                                                                                                                                  |
| `ODFT_ACCOMMODATION_AGENT_MCP_REGISTRY_PATH` | The accommodation agent's own MCP registry (its own token). Default: `mcp-registry.accommodation.json`.                                                                                                                                    |
| `ODFT_CITY_GUIDE_AGENT_MCP_REGISTRY_PATH`    | The City Guide agent's own MCP registry (its own token). Default: `mcp-registry.city-guide.json`.                                                                                                                                          |

**Derived by `npm run dev` — set only when starting a service directly:**

| Variable                                 | Meaning when set                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL` (agent process)           | The agent's restricted role connection. `npm run dev` builds it from the owner `DATABASE_URL` and the matching `ODFT_*_AGENT_PASSWORD`. Use `odft_flight_agent`, `odft_accommodation_agent` or `odft_city_guide_agent`; never the owner role. Example: `postgres://odft_flight_agent:odft_local_password@127.0.0.1:5442/odft`. |
| `ODFT_MCP_READONLY_DATABASE_URL`         | Read-only role connection used by the MCP host's data pool. Required when the MCP host is started directly; `npm run dev` derives it.                                                                                                                                                                                          |
| `ODFT_PROTOCOL_DATABASE_URL`             | Protocol/auth role connection used by the MCP host for delegation authorization and observations. Optional; falls back to the host's `DATABASE_URL`. `npm run dev` derives it.                                                                                                                                                 |
| `ODFT_FLIGHT_AGENT_REGISTRY_PATH`        | Inbound A2A registry for a standalone flight agent. `npm run dev` sets it to `ODFT_AGENT_REGISTRY_PATH`.                                                                                                                                                                                                                       |
| `ODFT_ACCOMMODATION_AGENT_REGISTRY_PATH` | Same for a standalone accommodation agent.                                                                                                                                                                                                                                                                                     |
| `ODFT_CITY_GUIDE_AGENT_REGISTRY_PATH`    | Same for a standalone City Guide agent.                                                                                                                                                                                                                                                                                        |

**Optional, defaults and test-only:**

| Variable                                                                                                                                                                 | Default / rule                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ODFT_FLIGHT_AGENT_HOST` / `ODFT_FLIGHT_AGENT_PORT`                                                                                                                      | `127.0.0.1` / `4401`.                                                                                                                                                                                         |
| `ODFT_ACCOMMODATION_AGENT_HOST` / `ODFT_ACCOMMODATION_AGENT_PORT`                                                                                                        | `127.0.0.1` / `4402`.                                                                                                                                                                                         |
| `ODFT_CITY_GUIDE_AGENT_HOST` / `ODFT_CITY_GUIDE_AGENT_PORT`                                                                                                              | `127.0.0.1` / `4403`.                                                                                                                                                                                         |
| `ODFT_MCP_HOST` / `ODFT_MCP_GEOGRAPHY_PORT` / `ODFT_MCP_TRAVEL_DATA_PORT` / `ODFT_MCP_ITINERARY_TOOLS_PORT`                                                              | `127.0.0.1` / `4321` / `4322` / `4323`.                                                                                                                                                                       |
| `ODFT_ACCOMMODATION_ALT_AGENT_PASSWORD`, `ODFT_AGENT_TOKEN_ACCOMMODATION_ALT`                                                                                            | Optional; replacement demo only (Agent B on port 4404).                                                                                                                                                       |
| `ODFT_ACCOMMODATION_ALT_AGENT_REGISTRY_PATH`, `ODFT_ACCOMMODATION_ALT_AGENT_MCP_REGISTRY_PATH`, `ODFT_ACCOMMODATION_ALT_AGENT_HOST`, `ODFT_ACCOMMODATION_ALT_AGENT_PORT` | Standalone Agent B only. The registry path is required when Agent B runs (example: `agent-registry.json`); the MCP registry is optional (unset = no outbound MCP); host/port default to `127.0.0.1` / `4404`. |
| `ODFT_ACCOMMODATION_ALT_AI_CONFIG_PATH`                                                                                                                                  | Optional distinct AI profile for Agent B; falls back to `AI_CONFIG_PATH`.                                                                                                                                     |
| `ODFT_FLIGHT_AGENT_CRASH`, `ODFT_ACCOMMODATION_AGENT_CRASH`, `ODFT_CITY_GUIDE_AGENT_CRASH`, `ODFT_ACCOMMODATION_ALT_AGENT_CRASH`                                         | Test-only; `1` exits after durable admission before any work. Default `0`.                                                                                                                                    |
| `ODFT_ACCOMMODATION_AGENT_STEP_DELAY_MS`, `ODFT_CITY_GUIDE_AGENT_STEP_DELAY_MS`, `ODFT_ACCOMMODATION_ALT_AGENT_STEP_DELAY_MS`                                            | Test-only artificial per-step delay in milliseconds for parallel-window tests. Default `0`.                                                                                                                   |
| `ODFT_MCP_TOKEN_GEOGRAPHY`, `ODFT_MCP_TOKEN_TRAVEL_DATA`, `ODFT_MCP_TOKEN_ITINERARY_TOOLS`                                                                               | Test-only credentials the MCP host uses when it acts as an MCP client in protocol tests. Not needed by `npm run dev`.                                                                                         |
| `ODFT_ALLOW_REMOTE_ROLES`                                                                                                                                                | Set to `1` only to let `npm run protocol:roles` manage roles on a non-local database. Default off (local hosts only).                                                                                         |

The A2A agents share `AI_MODE`/`AI_CONFIG_PATH`: the flight agent needs a validated `recommendation`
profile in OpenRouter mode, the accommodation agent optionally reuses it for its comparison, and the
City Guide agent is deterministic. Agent B may use a distinct profile via
`ODFT_ACCOMMODATION_ALT_AI_CONFIG_PATH`. Fixture mode stays deterministic and free.

Secrets stay on the server. They are never placed in `NEXT_PUBLIC_*` and never sent to the browser;
`npm run build` scans the client bundle to confirm this.

## Reference landmarks

City coverage is imported offline and stays reproducible: `data/reference/*.ndjson` pins the reviewed
landmark set (Rome, Paris, Barcelona) and leaves every other city `generic_only`, where the generator offers
only explicitly synthetic activity categories (`Approximate city-center walk`, `Demo relaxation break`,
`Unspecified local exploration`) instead of inventing real venues.

With `WIKIDATA_DISCOVERY=true` the worker curates such a city on demand before the scenario snapshot fixes its
`isCurated`: it fetches the city's notable attractions from Wikidata (CC0; instance-of attraction classes
ordered by sitelink count, coordinates envelope-checked, English labels), stores them as `wikidata:Q…` rows in
`odft_app.reference_landmarks` and flips the city to `curated_landmarks`, so every later trip reuses the stored
rows with no further lookup (the first creation takes a few seconds longer). An empty result marks the city
`insufficient_reference` and is not retried; a failed lookup leaves `generic_only` so the next trip retries,
and it never fails a trip. Already-materialized snapshots keep their activities. Restaurant businesses are
synthetic in every city; only landmark identity/coordinates come from reference data.

## Map tiles

The itinerary map is client-only Leaflet. Tiles come only from `MAP_TILE_URL`, an optional **public**,
credential-free `{z}/{x}/{y}` URL template validated at startup (`assertPublicTileUrl`): userinfo is
rejected and plain HTTP is refused when `PUBLIC_BASE_URL` is https. Point it only at a policy-compliant
provider (attribution is required and shown on the map; normal HTTP caching only; no bulk download or
offline tile packs).

```bash
# .env (optional)
MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
```

`{z}/{x}/{y}` are literal Leaflet placeholder tokens, not values you compute: keep them exactly as the
provider's documentation writes them and Leaflet fills in the needed tile coordinates per request based on
the current map view, so nothing depends on the destination city chosen at trip creation. Any
policy-compliant provider works as long as its template uses the same placeholders.

When `MAP_TILE_URL` is unset (the default), or the first tile does not load within five seconds, or tile
loads keep failing, the map renders the labeled SVG schematic instead; every map fact also exists as text.

## AI modes and configuration

The assistant rail and the intent pipeline run in one of two server-side modes (`AI_MODE`):

- **`fixture` (default, recommended for local work and CI).** Deterministic scripted interpretations,
  rankings, and plans. No credentials, no profile file, no network egress, zero billable rows. Each
  message still becomes one admitted operation and one conversation entry.
- **`openrouter`.** Live calls to OpenRouter models configured per role. Requires `OPENROUTER_API_KEY`
  and `AI_CONFIG_PATH`; startup fails closed with `AiConfigError` when either is missing or a profile is
  invalid. There is no invented model id and no automatic free/fallback model.

### What `AI_CONFIG_PATH` is

Path to a JSON file holding **all four role profiles** (`intent`, `recommendation`, `planner`,
`reviewer`) — the model, sampling settings, hard token/time limits, verified USD price ceilings, and the
endpoint provider slugs allowed to serve the calls. Relative paths resolve from the repository root.
Start from the committed template:

```bash
npm run setup:config
# edit: model id, allowedEndpointProviderIds, price ceilings
```

`ai-profiles.json` and its generated cache are git-ignored (operator-specific models and prices).

Example (`ai-profiles.json`, one role shown; all four roles use the same shape):

```json
{
  "intent": {
    "provider": "openrouter",
    "model": "openai/gpt-6-luna",
    "timeoutMs": 20000,
    "maxInputTokens": 6000,
    "maxOutputTokens": 1024,
    "maxAttempts": 2,
    "maxCallCostUsd": "0.05",
    "inputPriceUsdPerMillion": "0.9",
    "outputPriceUsdPerMillion": "1.5",
    "requestPriceUsd": "0.01",
    "pricingVersion": "unverified",
    "allowedEndpointProviderIds": ["openai"]
  },
  "recommendation": { "...": "same shape" },
  "planner": {
    "...": "same shape, e.g. timeoutMs 30000 / maxOutputTokens 2048 / maxCallCostUsd 0.20"
  },
  "reviewer": { "...": "same shape" }
}
```

| Field                                                                    | Rule                                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider`                                                               | Must be `"openrouter"`                                                                                                                                 |
| `model`                                                                  | Exact OpenRouter model id (`author/slug`)                                                                                                              |
| `reasoningEffort`                                                        | Optional: `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`; must be supported by the matched endpoint                                              |
| `temperature`                                                            | Optional, 0–2; only when the matched endpoints publish `temperature` — an unpublished parameter makes routing fail with HTTP 404 (checked pre-billing) |
| `timeoutMs`                                                              | 1000–45000; keep below the worker operation lease (default 60 s)                                                                                       |
| `maxInputTokens`                                                         | ≤ 6000 (whole role input cap, history included)                                                                                                        |
| `maxOutputTokens`                                                        | Role output cap (defaults: 1024; reviewer 2048, planner 6144; hidden reasoning tokens count toward it)                                                 |
| `maxAttempts`                                                            | 1–2 (the adapter owns at most one repair/retry; never stacked)                                                                                         |
| `maxCallCostUsd`                                                         | Worst-case per-call ceiling in USD; the tool refuses a profile whose worst case exceeds it                                                             |
| `inputPriceUsdPerMillion`, `outputPriceUsdPerMillion`, `requestPriceUsd` | **Verified upper bounds** (USD); must be ≥ every matched endpoint's published rate, otherwise the call fails closed before billing                     |
| `pricingVersion`                                                         | Machine-managed pin; leave `"unverified"` and let `ai:validate-models` stamp the manifest version                                                      |
| `allowedEndpointProviderIds`                                             | Endpoint provider slugs (OpenRouter `tag`) allowed to serve the calls; fallback is disabled                                                            |

### Setting it up (first run)

```bash
# 1. .env: AI_MODE=openrouter, OPENROUTER_API_KEY=..., AI_CONFIG_PATH=./ai-profiles.json
# 2. copy the committed templates (AI, voice and protocol registries)
npm run setup:config
# 3. refresh capability/pricing and validate every configured model profile
npm run validate:models
```

`npm run validate:models` runs `ai:validate-models` first and then
`voice:validate-models` when `VOICE_CONFIG_PATH` is set (or voice is enabled);
otherwise it skips voice with a note. The individual `ai:validate-models` and
`voice:validate-models` commands remain available for targeted runs.

`ai:validate-models` fetches `https://openrouter.ai/api/v1/models/{id}/endpoints` for each configured
model, writes the verified manifest to `$AI_CONFIG_PATH.capabilities.json`, stamps the manifest's
`pricingVersion` into the profiles, and asserts every role profile. Failures are actionable:

- _no endpoint from the allowed providers; available: …_ → put one of the listed slugs into
  `allowedEndpointProviderIds` (slugs without "no structured outputs").
- _configure at least X_ → raise the matching price field to `X` (published worst case for the shown
  model).
- _HTTP 404_ → the model id does not exist on OpenRouter.

The worker re-reads the cached manifest and fails closed with an actionable error when it is missing,
stale (> 24 h), or does not cover the configured models. It never refreshes the manifest itself, so the
operator-verified `pricingVersion` pins stay in operator control: re-run `npm run ai:validate-models`
whenever it asks, then restart the worker so it reloads the profiles and the manifest. A model whose
capability or pricing is unknown is never called.

The committed example uses `openai/gpt-6-luna`; its endpoints publish `reasoning` and `reasoning_effort`.
Hidden reasoning tokens count toward `maxOutputTokens` (and dominate latency), and Luna's unpinned effort
regularly truncated reviews/plans at the output cap, so the example pins `reasoningEffort: "low"` on the
planning roles — raise it only when you want deeper thinking. The Luna
endpoints do not publish `temperature`, so the example omits it too: a profile
`temperature` against endpoints without the parameter fails closed before billing (OpenRouter routing
with `require_parameters` would reject the whole request with a 404 otherwise). The example price fields
are the verified worst case over the matched
`openai`-prefixed endpoint variants (`openai` and `openai/fast`; a base slug also matches its
variants): prompt 0.40 + cache write 0.50 = 0.90 USD/M input, 1.50 USD/M output, 0.01 USD per web
search, giving a worst-case call of $0.016936 (intent) and $0.018472 (planner) — comfortably under
the example ceilings.

### What the assistant can do

- Interpret a free-text request into the **same deterministic commands** the graphical controls use
  (route/date, service levels, pace, interests, activity counts, budget, program submission) and apply
  the whole batch **atomically**: a command that cannot be honored leaves none of the batch applied.
- Ask a **bounded clarification** (2–4 labelled options) when a request is ambiguous, conflicts with a
  `preserve`d service, repeats the same preference, or would change the route after a confirmed booking.
  Options are server-side bound: only the opaque option id is submitted.
- **Never** confirm, cancel, or book anything, and never claim unconfirmed success. Prompt-injection text
  in a message or in persisted content cannot become an executable booking operation.
- Handle a **search request** ("find a cheaper hotel") as a targeted refresh of demo alternatives,
  preserving the selected/confirmed category unless explicitly changed; a result is not a replacement
  booking, and the current reservation remains active until confirmation.
- Fail **visibly**: an AI failure is terminal for that message (no silent retry, no stacked billable
  call); the conversation shows the failure and the graphical controls keep working.

### Budgets and failure behavior

- Every transport attempt reserves its worst-case cost in `llm_calls` **before** the call, under a short
  per-trip SQL lock; retries count. `MAX_LLM_CALLS_PER_TRIP` / `MAX_LLM_COST_USD_PER_TRIP` and the role's
  `maxCallCostUsd` refuse further calls with a typed `AI_BUDGET_EXCEEDED`.
- An uncertain charge (timeout/transport/abort) stays `unknown_reserved` and is never released as zero;
  it is cleared only by explicit reconciliation.
- AI failures are terminal for that operation: a message is never automatically re-sent through the coordinator
  and no second billable call is stacked on it. The trip stays usable (the last decision/controls keep
  working); a graceful shutdown is the exception and leaves the operation recoverable.
- Prompts, raw model output, and reasoning are never persisted for display; only safe telemetry (role,
  model, prompt-version label, tokens, latency, cost status) is projected.

## Voice control (optional)

Voice control is opt-in and off by default (`VOICE_ENABLED=true` shows the Dictate controls in the
assistant rail). The graphical and keyboard app is complete without it.

- **Fixture mode (`AI_MODE=fixture`, the default).** Dictation returns the scripted test transcript and
  spoken replies return generated test WAV audio: no credentials, no profile file, no network egress, and
  zero billable rows. Fixture audio is test audio — it is not proof of live TTS.
- **Live mode (`AI_MODE=openrouter`).** Requires `VOICE_CONFIG_PATH` and the **dedicated**
  `OPENROUTER_STT_API_KEY`. Missing live configuration is an explicit voice-only `503`; the UI reports
  voice as unavailable and typed chat keeps working (never a silent fallback to another key or model).

### What `VOICE_CONFIG_PATH` is

Path to a JSON file holding exactly two speech profiles (`stt`, `tts`) plus strict limits (60 s recording,
2 MiB request / 8 MiB response audio, 2 000 transcript/reply characters, 60 calls and 1.00 USD per trip).
Relative paths resolve from the repository root. Start from the committed template:

```bash
npm run setup:config       # creates voice-profiles.json from the committed template
# optional: narrow the limits; the models, the groq STT endpoint, and the voice
# alias are documented defaults and are enforced by the validator
npm run validate:models    # validates AI profiles and, when configured, voice profiles
```

`voice-profiles.json` and its generated cache are git-ignored. The validator fetches the public
OpenRouter endpoint metadata, verifies the exact model ids/modalities/endpoint/billing units and exact
pricing precision, writes `$VOICE_CONFIG_PATH.capabilities.json`, and stamps the verified
`pricingVersion`. It validates **public metadata only**: the assigned-key policy and real serving/billing
remain operator gates.

### Dedicated Groq-restricted STT key (live mode)

Speech-to-text must route only to Groq, and the OpenRouter speech API has no per-request provider pin, so
the restriction lives on the key. Guardrails are managed per workspace
(Workspaces → Default → Guardrails) and need organization-admin access:

1. Create a **new inference key** for speech-to-text.
2. Create a guardrail with a **provider allowlist of exactly `groq`** and a **model allowlist of exactly
   `openai/whisper-large-v3-turbo`**.
3. **Assign** that guardrail to the new key — a guardrail enforces nothing until it is assigned.
4. Set only that key as `OPENROUTER_STT_API_KEY` and restart the web process.

The shared `OPENROUTER_API_KEY` stays unrestricted for TTS/reasoning and is never used for STT. Native
Groq/ElevenLabs credentials are not accepted anywhere; keys are server-side only, never in URLs, bodies,
or the browser. Before treating live voice as enabled, verify the effective policy (a disallowed model
must be refused) and the real serving/billing with a short non-sensitive recording.

### Behavior and requirements

- **Dictation only fills the draft.** Automatic completion (a two-second speech pause), manual _Stop
  recording_, and the 60-second hard cap all transcribe into the composer; a longer pause may split the
  question, so edit the draft or dictate more before sending. Sending always requires an explicit _Send_
  click — voice never admits a command.
- **Local VAD.** Speech detection runs in the browser with the pinned Silero model; the model, worklet,
  and matching ONNX runtime files are served same-origin from `/voice-vad/` (prepared before web dev and
  builds, licenses recorded in the generated `MANIFEST.json`; no CDN, no audio frames leave the device,
  no VAD provider billing). If the detector cannot load, the UI says automatic stopping is unavailable
  and manual recording still works.
- **Replies.** "Read replies aloud" is per-tab and starts off; the first explicit Dictate enables it, and
  turning it off later is respected. Playback starts in a user gesture; if autoplay stays blocked, a
  _Play reply_ button appears. Only settled assistant replies are spoken — never cards, history, or your
  own text.
- **Browser prerequisites.** Microphone capture needs a secure context (https or localhost) and
  permission; an unsupported browser shows the unsupported copy and typed chat remains.
- **Separate accounting.** Voice calls are tracked in their own `voice_calls` ledger (USD plus
  seconds/characters); they never count as LLM calls and never change trip revisions, decisions, or
  bookings.
- **Current verification status.** Fixture-mode behavior is covered by the unit/integration/E2E suites
  (the final Phase 12 gate ran 532 unit tests, including the voice suites; the voice-specific subset is
  24 integration tests and 14 desktop / 13 mobile E2E cases, plus the affected regressions). A
  provider-level live smoke ran on 2026-10-15: real transcript from a short synthetic recording, Groq
  serving evidence with the documented 10-second minimum (`usage.seconds = 10`), and an ElevenLabs
  `eleven-v4-turbo-20260930` MP3 at the expected cost. Still pending: the assigned-guardrail
  effective-policy proof, the full in-app live flow, audible listening, and real mobile/Safari/Firefox
  behavior.

## Database safety

- `docker compose down` preserves the named volume. Only an explicitly requested reset may remove it.
- Integration tests use a separate disposable database (`TEST_DATABASE_URL`, default `odft_test`).
  They drop and recreate the `odft_app` and `odft_protocol` schemas, so never point
  `TEST_DATABASE_URL` at a database that holds data you care about.
- Migrations run under a session-level advisory lock and are recorded with content checksums; a
  modified applied migration is rejected instead of silently diverging.

## Health

`GET /api/health/ready` returns `200` only when the database is reachable, migrations are applied,
and a worker heartbeat is recent; otherwise `503`. Liveness never calls OpenRouter or map tiles.

## Shutdown

Stop the dev processes with `Ctrl+C` (termination is forwarded to all children), then stop the
database with `docker compose down`.
