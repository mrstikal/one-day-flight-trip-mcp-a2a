# AI Travel Planner: Project Overview

## 1. Scope and Baseline

This is the implementation-ready architecture requested by `ODFT_BRIEF.md`, including its final trip/flight feasibility requirement. The brief explicitly forbids application-code implementation during planning. These files are specifications, contracts, decisions, and instructions for later phase-by-phase implementation.

Repository analysis on 2026-10-10 found no application code, package manifest, database migrations, test runner, build, or CI. `ODFT_PLAN.md` was empty. Root `AGENTS.md` requires English code/documentation and Czech chat. `agent-memory/index.md` and the baseline notes were read; no application architecture was recorded there. Existing `.gitignore` ignores the brief, root plan, project memory, and IDE files; preserve it. The detailed specifications under `docs/planning/` are not covered by those ignores.

This plan does not claim that implementation has run or that a model unavailable in an execution environment has been selected. Each later phase starts with analysis, proceeds to implementation, verifies acceptance, and stops before the next phase.

## 2. Product

A hybrid graphical/conversational planner for one full sightseeing day in a European city, with synthetic flights, accommodation, meals, attractions, entertainment, cost estimates, and internal demo reservations. The user selects country, city, origin airport, date, adults, travel variant, quality preferences, and activity pace. No account registration, payment, or real travel booking is included.

The application is in English. Permanent disclaimer:

**DEMO APPLICATION - No real reservations are made and no payments are processed.**

Every confirmation additionally says:

**Simulated booking - not valid for travel, accommodation, or restaurant admission.**

The original brief uses typographic separators; the wording and meaning are preserved with ASCII separators for repository editing conventions.

## 3. Final Technology Stack

Version baseline checked 2026-10-10. Exact pins below deliberately avoid unreviewed major upgrades. Other listed packages are resolved to compatible patches and pinned in Phase 01's single lockfile; this is dependency setup, not a deferred architectural decision.

| Concern            | Decision                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Runtime            | Node.js 24 LTS, self-hosted; not Node 20 (EOL) or pre-LTS Node 26                                                       |
| Language           | TypeScript 5.9.3, strict; keep established compiler/plugin APIs instead of automatically upgrading to the new TS 7 line |
| Web                | Next.js 16.4.0 App Router, React/React DOM 19.3.0                                                                       |
| Styling            | Tailwind CSS 4.3.3, CSS-first `@theme` and `@import`; no Tailwind JS configuration                                      |
| Accessible UI      | Native controls plus narrowly used Radix primitives (dialog, popover, tabs); no component framework/generator           |
| Graph              | `@langchain/langgraph` 1.4.21, Graph API, `@langchain/core` 1.2.17                                                      |
| Checkpointing      | `@langchain/langgraph-checkpoint-postgres` 1.0.6; official setup/migrations                                             |
| Runtime validation | Zod 4.6.5, strict discriminated unions                                                                                  |
| Database           | PostgreSQL 17, `pg` 8, SQL migrations; no ORM                                                                           |
| Synthetic data     | `@faker-js/faker` 10.6.0 plus domain generators and persisted snapshots                                                 |
| Geography          | GeoNames, OurAirports, curated Wikidata; imported/filter-validated offline assets                                       |
| Time zones         | Import-time `geo-tz/all` 8.1.9; Node Intl/IANA rules; explicit evidence/overrides                                       |
| Dates/times        | `@js-temporal/polyfill` 0.5.1; ISO local dates and UTC instants                                                         |
| Geometry           | Small tested haversine helper and reviewed safe anchors; no online geocoding/routing                                    |
| Maps               | Leaflet 1.9.4 directly in a client-only component; compliant optional tiles and offline schematic fallback              |
| LLM transport      | Native server `fetch`, provider-independent typed adapter; initial provider OpenRouter                                  |
| Testing            | Vitest 5.0.3 with compatible Vite 8; React Testing Library; Playwright; real PostgreSQL integration tests               |
| Tooling            | npm workspaces, ESLint flat config compatible with Next, Prettier, `tsx` for development                                |
| Local deployment   | Docker Compose: PostgreSQL plus web/worker; explicit migration/checkpointer setup                                       |
| Observability      | PostgreSQL event/cost ledger, same-origin SSE, graphical execution inspector                                            |

No LangGraph SDK/Platform dependency is needed to connect the UI. Verify package resolution, peer dependencies, and a production build before accepting Phase 01. Never substitute a different runtime/architecture silently if a listed package fails resolution; report the concrete incompatibility.

## 4. Design Summary

- One Next.js BFF and one dedicated graph worker; PostgreSQL is both durable domain store and work/event/checkpoint store.
- Graph checkpoints own execution position, while domain rows own preferences, selections, bookings, and artifact versions.
- One writer per trip, optimistic revision checks, request deduplication, operation fencing, and idempotent SQL effects reconcile graph/domain crash windows.
- Stage A deterministically validates practical route eligibility before synthetic flight generation; Stage B independently validates each generated schedule.
- Approval fingerprints bind current origin, city, date, variant, reference/rule versions, and transfer settings. Restored checkpoints cannot reuse an unrelated `FEASIBLE` result.
- Independent hotel/meal/attraction/event research uses `Send` fan-out and a keyed reducer/fan-in. Selective changes dispatch only affected domains.
- One reusable pure interrupt node displays strict decision kinds for flight choice, hotel choice, booking confirmation, program selection, itinerary approval, clarification, and recovery.
- AI proposes commands/rankings/schedules/reviews; deterministic code authorizes, executes, prices, validates, and books.
- Service preferences inherit locally, confirmed reservations remain fixed until explicit replacement approval, and pace controls intensity independently of interest categories.
- Stable scenario snapshots, separate domain seeds, fixture AI, and persisted fault overlays make A-N demonstrations reproducible without API credentials.

## 5. Specification Map

| Document                                                    | Authoritative topic                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [01 Functional requirements](01-functional-requirements.md) | Feature IDs, scope, acceptance/brief traceability                                  |
| [02 Architecture](02-architecture.md)                       | Runtime topology, module boundaries, admission and durable operation model         |
| [03 LangGraph](03-langgraph-design.md)                      | State, nodes/edges, reducers, interrupts, recovery, selective invalidation         |
| [04 Domain model](04-domain-model.md)                       | Strict data/command/decision contracts and SQL invariants                          |
| [05 Synthetic data](05-synthetic-data-design.md)            | Offline licenses, geographic scope, feasibility, generators, pricing, A-N controls |
| [06 AI design](06-ai-agent-design.md)                       | Roles, provider adapter, prompts, validation, costs, fixture mode                  |
| [07 Conversation](07-conversation-and-intents.md)           | Intent interpretation, compact context, command examples, conflict UX              |
| [08 Frontend UX](08-frontend-ux.md)                         | Wizard, assistant, map, timeline, inspector, responsive/accessibility rules        |
| [09 Booking](09-booking-simulation.md)                      | Proposal/confirmation/replacement lifecycle and idempotent commits                 |
| [10 Security](10-security-reliability.md)                   | Sessions, ownership, CSRF/rate limits, prompt injection, error/recovery model      |
| [11 Testing](11-testing-strategy.md)                        | Unit/integration/E2E/invariant tests, restart/crash/concurrency evidence           |
| [12 Roadmap](12-implementation-roadmap.md)                  | Twelve phases, dependency gates, exact Phase 01 instructions                       |
| [13 Architecture review](13-architecture-review.md)         | Independent findings/corrections, tradeoffs, risks, and verification limits        |

Architectural decisions are in [decisions](decisions/ADR-001-runtime.md). The [root plan](../../ODFT_PLAN.md) is the executive entry point. Each fact/contract has one authoritative home; other documents link to it rather than inventing a competing definition.

## 6. Success and Non-goals

Success means all 30 brief success criteria and all mandatory feasibility regressions are covered by implementation and tests, not merely that a screenshot displays an itinerary. Restart/interrupt/selective-replanning behavior must be observable and verified against real PostgreSQL.

Non-goals: real availability/timetables, commercial provider integration, payments, login, ticket/visa advice, live road navigation, worldwide travel, children/multi-room customization, production-scale infrastructure, autonomous agent spawning, or hidden LLM reasoning inspection.

## 7. Top Five Architectural Risks

| Risk                                                                       | Mitigation and required evidence                                                                                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph/domain commit mismatch or duplicate booking after replay             | Effect ledger + atomic reservation transaction + one trip writer; crash after commit before checkpoint test                                     |
| Stale feasibility approval restored after route changes                    | Canonical current-input fingerprints and independent generator/booking guards; PRG/Rome -> Ceske Budejovice restart/resume regression           |
| DST, transfer, meal, and airport windows make a plausible route invalid    | UTC instants, Temporal, two independent feasibility stages, exact selected-logistics and itinerary validators; DST/late-flight tests            |
| Selective changes accidentally mutate confirmed/unrelated services         | Explicit invalidation matrix, proposal/confirmation lifecycle, content-hash and reservation-ID invariant tests                                  |
| LLM schema/candidate/cost failures or inconsistent external reference data | Strict unions, membership checks, role capability/pricing validation, call reservations/limits, fixture mode, offline data/license/import gates |

## 8. External Dependencies and Assumptions

Node 24, npm, Docker/PostgreSQL access, and Playwright browser installation are implementation prerequisites. OpenRouter credentials and explicitly configured structured-output-capable model IDs are required only for live AI acceptance; fixture mode is complete without them. Optional tiles require a policy-compliant provider and can fail without preventing planning.

Data source terms, package APIs, and political time-zone changes may change after this planning date. Imports pin real artifacts and licenses; the implementation may not fabricate checksums or assume upstream `latest` remains compatible. Model capability/pricing validation is an execution-time configuration gate, not an open architecture choice.

No unresolved major architectural choice is delegated to the implementation model. Remaining operational inputs are credentials/model IDs, actual reference import timestamps/checksums, environment-specific ports/secrets, and locked image/package patch resolution.

## Voice control scope addendum (2026-10-15)

An **optional, additive** voice interface extends the assistant rail (plan: [`../../VOICE_CONTROLL.md`](../../VOICE_CONTROLL.md), decisions: [ADR-008](decisions/ADR-008-voice-interface.md)). It is off by default (`VOICE_ENABLED=false`) and the graphical/keyboard app is complete without it.

- Dictation and spoken replies use **audio transport**, separate from the four reasoning roles: two exact model IDs, both through the OpenRouter gateway — `openai/whisper-large-v3-turbo` for speech-to-text (via a **dedicated, Groq-restricted key**) and `elevenlabs/eleven-v4-turbo` for text-to-speech (shared key).
- Speech has its own adapters, operator profile (`voice-profiles.json`), capability/pricing snapshot, USD budget and `voice_calls` ledger; it never merges with LLM calls, travel EUR money, trip revisions, decisions, or bookings.
- Speech detection runs **locally in the browser** (pinned Silero VAD, self-hosted assets, no VAD provider billing); only finished canonical WAV recordings reach the owned BFF.
