# Phase 03 - Domain Contracts, Persistence, Admission, and Deterministic Booking Service

Status: implementation plan (planning only). No application code, migration, or test exists on 2026-10-10. All
TypeScript/SQL blocks are future targets. This phase ships strict contracts, SQL migrations, the command
admission transaction, the effect ledger, and the sole reservation writer (`BookingService`). It ships no
synthetic generator, no graph/worker, and no UI.

## 1. Goal

Make trip/domain state durable and bookable without any LLM: strict Zod domain contracts, PostgreSQL tables for
sessions/trips/proposals/reservations/operations/effects, the idempotent command-admission transaction, and a
deterministic `BookingService` that is the only code path that can create, supersede, or cancel a demo
reservation. Owns FR-BOOK-1..7, FR-PRD-3, and the persistence half of FR-GRAPH-5/6.

## 2. Prerequisites

- Phase 02 complete: reference tables/loader and lookup services (trips reference admitted city/airport IDs).
- Phase 01 commands available: `db:migrate`, `typecheck`, `lint`, `test:unit`, `test:integration`, `build`.
- Real PostgreSQL 17 at `TEST_DATABASE_URL`; integration tests use it and never a production database.
- Test fixtures supply scenario snapshots, offers, and persisted route/schedule approval records before the
  generator exists (Phase 04); this phase must not depend on the Phase 04 engine.

## 3. Source Inputs (authoritative)

- docs/planning/04-domain-model.md sections 1-3, 5-7, 9, 11 (contracts, trip aggregate, offers, commands,
  decisions, SQL inventory, invariants).
- docs/planning/09-booking-simulation.md sections 2-9 (references, lifecycle, proposal/confirmation flows,
  replacement ordering, idempotency, fault windows).
- docs/planning/02-architecture.md sections 5-7 (sources of truth, admission transaction, effect ledger).
- docs/planning/01-functional-requirements.md FR-BOOK-1..7, FR-PRD-3.
- docs/planning/11-testing-strategy.md T-UT-BOOK-01, T-IT-BOOK-01..06, T-IT-CONC-01, Phase 03 gate.
- Read current docs; older task comments are not authoritative.

## 4. Binding Decisions (do not re-decide)

- Proposal lifecycle lives in `selection_proposals`; no reservation row/reference exists before confirmation.
  `reservations` rows use only `confirmed`/`superseded`/`cancelled`. There is no standalone cancel API/UI; the
  only cancellation path is an approved route-change impact confirmation.
- Demo references: `DEMO-FLT-`/`DEMO-HTL-`/`DEMO-RST-` + 20 uppercase hex characters (80 random bits,
  `crypto.randomBytes(10).toString("hex").toUpperCase()`), global SQL uniqueness, bounded 3 attempts inside a
  `SAVEPOINT`; exhaustion rolls back with `REF_GENERATION_FAILED` and leaves the old reservation intact.
- Replacement is one transaction: `UPDATE old SET status='superseded'` BEFORE `INSERT new SET status='confirmed'`
  because PostgreSQL partial unique indexes are checked immediately, not deferred to commit. The old reservation
  stays active until the replacement confirmation commits.
- Trip creation: unique `(session_id, creation_request_id)` plus creation payload hash; create at revision 1 with
  its initialization operation in one transaction. Duplicate creation returns the same trip/operation; a changed
  payload under the same key is a conflict. Only admitted user requests increment `trip.revision`, exactly once
  per request; worker-derived writes never increment it.
- Admission: dedupe on `(trip_id, request_id)` first; `SELECT ... FOR UPDATE` the trip; compare `expectedRevision`;
  reject a conflicting queued/running operation with `409 OPERATION_IN_PROGRESS`; one queued/running operation per
  trip via partial unique index; insert the immutable payload with the accepted revision; deterministic winner for
  simultaneous same-revision commands.
- Effect ledger: unique `(operation_id, node_name, effect_scope)` in `workflow_effects`; a replayed node returns
  the stored result instead of re-executing. Domain effect + effect result commit together.
- Decisions: public responses are exactly `PublicDecisionResponse` and exclude `modify`; the internal
  `GraphResumeEnvelope` (operationId, acceptedRevision, decisionId, internal response) is worker-constructed only.
  Confirmation and itinerary approval are decision responses, never model-emittable commands.
- Clarifications: an `IntentResult` clarification persists the original typed `requestedCommands` (0..4, not
  executed) and the `preserve` scope separately from its alternative options. A deterministic conflict found
  after an otherwise-valid `commands` result is converted into this same clarification form before any partial
  execution, so a numeric requirement (e.g. six museums) survives while the user decides.
- Category eligibility for relative searches binds the proposal target (the selected/confirmed offer), not the
  current global default: "find a cheaper hotel" uses the booked/selected offer's category even if the global
  default changed afterwards; only an explicit `find_alternatives.level` changes the category.
- All prices are integer EUR minor units, party totals, EUR adults only; demo offers in this phase are fixture
  data marked `synthetic: true`.
- Schema tables for `scenario_snapshots`, `route_validations`, `schedule_validations`, and `pending_decisions` are
  created here with their constraints; Phase 04 populates snapshot/approval content and Phase 05 drives decision
  lifecycle. Do not claim their later-phase tests.

## 5. Detailed Ordered Steps

1. Create `packages/contracts/src/` schemas: primitives (IDs, dates, instants, zones, money, coordinates,
   fingerprints), enums, `TripPreferences`, `DomainCommand` union, `PublicDecisionResponse`,
   `GraphResumeEnvelope`, `IntentResult`, API request/response envelopes, and the safe error envelope
   `{ code, message, retryable, currentRevision?, operationId? }`. Strict objects, reject unknown keys.
2. Create `packages/domain/src/` deterministic helpers: `resolveEffectiveLevel(preferences, service)`, trip date
   math (check-in `D-1`; checkout `D`/`D+1`; arrival `D-1`; late return `D`/`D+1`; injected clock; valid
   sightseeing date window), command semantic checks (duplicate/conflicting fields, `preserve` conflicts,
   `set_route` requires a changed field, country resolved from city), and fingerprint canonicalization
   (SHA-256 of sorted-key canonical JSON).
3. Write migration `0003-domain.sql` in the Phase 01 `odft_app` schema: `anonymous_sessions`, `trips` (unique session/creation-request ID and
   creation payload hash, `revision >= 0`, preference JSONB), `scenario_snapshots`, `route_validations`,
   `schedule_validations`, `trip_selections`, `selection_proposals`, `reservations`,
   `pending_decisions`, `workflow_operations`, `workflow_effects`, `execution_events`, `conversation_messages`,
   `conversation_summaries`, `workflow_control_requests`, `recommendation_artifacts`, `itineraries`, `simulation_faults`, `rate_limit_buckets`, and `llm_calls` with canonical bounded payloads. Include FKs, CHECK enums and partial unique indexes. Retain Phase01 heartbeat/Phase02 references.
4. Implement `packages/persistence/src/` repositories with raw `pg` transactions: sessions, trips, proposals,
   reservations, operations, effects, events. Validate JSONB on read and write with the contracts schemas.
5. Implement `admitOperation()` and `createTrip()` exactly per the admission transaction; return `409` codes
   `STALE_REVISION`/`OPERATION_IN_PROGRESS`, and dedupe results with payload-hash comparison.
6. Implement `withEffect(operationId, nodeName, effectScope, fn)`: insert-or-read the ledger row in the same
   transaction as the domain effect; replay returns the stored result.
7. Implement `BookingService` (section 7): `proposeSelection`, `confirmBooking`, `replaceConfirmed`, and
   `generateDemoReference` with `SAVEPOINT`-bounded retry. Enforce ownership, proposal state/expiry, offer
   membership in the persisted snapshot, party/date/variant agreement, disclaimer acknowledgment, and current
   approval fingerprints. Same-offer confirmation with a new key returns the existing active reservation.
8. Implement selection/proposal flags that later phases consume: `selectedBy: "user" | "default"`,
   source fingerprint, snapshot/offer refs, active proposal/reservation refs.
9. Build deterministic fixtures under `tests/fixtures/`: one session, one trip, one `scenario_snapshots` row with
   hotel/meal/flight offers, one `FEASIBLE` `route_validations` row, one `VALID` `schedule_validations` row. These
   are test inputs, not generated engine output.
10. Write the tests in section 10 against real PostgreSQL; use two independent connections for concurrency tests.
11. Document the exported service API in code comments only where needed; no README files unless requested.

## 6. Concrete Target Paths

```text
packages/contracts/src/{primitives,enums,preferences,commands,decisions,errors,api,operations}.ts   # @odft/contracts
packages/domain/src/{preferences,dates,commands,fingerprints,errors}.ts                   # @odft/domain
packages/domain/src/booking/{booking-service,references,lifecycle}.ts
packages/persistence/migrations/0003-domain.sql                                           # odft_app schema
packages/persistence/src/{sessions,trips,proposals,reservations,operations,effects,events,decisions}.ts
packages/persistence/src/admission.ts                                                    # @odft/persistence
tests/fixtures/{session,trip,snapshot,approvals,offers}.ts
tests/unit/domain/{preferences,dates,commands}.test.ts
tests/unit/domain/references.test.ts
tests/integration/booking/{create-trip,confirm,replace,idempotency,authorization}.test.ts
tests/integration/booking/concurrency.test.ts
packages/{contracts,domain,persistence}/src/index.ts, package-lock.json  # minimal export/dependency wiring
```

## 7. Functions and Interfaces to Implement

```typescript
// contracts
type DomainCommand = /* strict discriminated union exactly as 04-domain-model.md section 6 */;
type PublicDecisionResponse = /* strict union exactly as 04-domain-model.md section 7, without "modify" */;
interface GraphResumeEnvelope { operationId: string; acceptedRevision: number; decisionId: string; response: InternalDecisionResponse; }

// admission
createTrip(input: ValidatedCreationInput, session: Session): Promise<{ tripId: string; operationId: string; revision: 1 }>;
admitOperation(input: { tripId: string; session: Session; request: CommandRequest }):
  Promise<{ status: "accepted"; operationId: string; revision: number } | ErrorEnvelope>;
admitResume(input: { tripId: string; session: Session; request: ResumeRequest }): Promise<OperationQueued>;

// ledger
withEffect<T>(tx: Tx, key: { operationId: string; nodeName: string; effectScope: string }, fn: () => Promise<T>): Promise<T>;

// booking
class BookingService {
  propose(input: { tripId: string; service: BookableKey; offerId: string; operationId: string }): Promise<ProposalResult>;
  confirm(input: { tripId: string; proposalId: string; decisionId: string; operationId: string; acceptedDemoDisclaimer: true; confirmationKey: string }): Promise<ReservationResult>;
  replaceConfirmed(input: AuthorizedConfirmationInput): Promise<ReservationResult>; // internal confirm path, not another public writer
  generateDemoReference(service: BookableKey): string; // DEMO-FLT|HTL|RST + 20 uppercase hex
}
```

`generateDemoReference` is called only inside the confirmation transaction. A demo reference is display-only and
never authorization.

`AuthorizedConfirmationInput` includes admitted operation/fencing context, proposal/decision and explicit disclaimer acknowledgment. Stored payloads are a strict start/command/resume union, not executable unknown data. Technical retry is a control record requeuing the same immutable operation, not new business input.

## 8. Outputs / Deliverables

- Strict Zod contracts and deterministic domain helpers importable by web, worker, and data packages.
- `0003-domain.sql` (schema `odft_app`) applied by `npm run db:migrate` with all required partial unique indexes.
- Admission + effect-ledger repositories with typed conflicts.
- `BookingService` with the exact confirmation/replacement ordering and idempotency guarantees.
- Real-PostgreSQL integration tests and fixture builders listed in section 10.

## 9. Measurable Acceptance Criteria

- AC-03-1: reference format matches `/^DEMO-(FLT|HTL|RST)-[0-9A-F]{20}$/`; a forced collision retries at most 3
  times and then fails without leaving a reservation.
- AC-03-2: duplicate confirmation (same request key, sequential and concurrent via two real connections) yields
  exactly one reservation row and one stored effect result; same key with a different payload is rejected.
- AC-03-3: a new request key for the same offer returns the existing active reservation without a new reference.
- AC-03-4: exactly one `confirmed` reservation per `(trip_id, service_key)` at all times, enforced by the partial
  unique index; a replacement never violates it because the old row is superseded before the insert.
- AC-03-5: wrong offer/foreign trip/stale fingerprint/resolved decision/wrong revision produce typed conflicts
  with zero reservation rows and zero side effects.
- AC-03-6: `trip.revision` increments exactly once per admitted request, monotonically; duplicates return the
  stored operation; concurrent same-revision commands have one winner and the loser gets `409`.
- AC-03-7: effect replay returns the stored result and never re-executes the domain effect.
- AC-03-8: no payment/travel-provider field, module, or endpoint exists; the reservation table has no payment
  columns.
- AC-03-9: trip creation dedupe: two identical creation requests return one trip/operation; changed payload under
  the same `(session_id, creation_request_id)` is rejected.

## 10. Commands and Tests

```text
npm run db:migrate
npm run typecheck
npm run lint
npm run test:unit          # T-UT-BOOK-01, T-UT-PREF-02 (inheritance helper), T-UT-PREF-03 subset (date math)
npm run test:integration   # T-IT-BOOK-01..06, T-IT-CONC-01, admission/creation tests with TEST_DATABASE_URL
npm run build
```

Integration tests must use real SQL migrations and the real `pg` driver; no mocked database. Concurrency tests
open two independent connections as required by T-IT-CONC-01. Do not claim graph, feasibility, or UI tests here.

## 11. Explicit Out of Scope

- Synthetic generator, seeds, snapshots content, pricing, Stage A/B (Phase 04).
- Graph, worker, checkpointer, `pending_decisions` lifecycle driving, SSE (Phase 05).
- Wizard UI and booking dialogs (Phases 06-07).
- LLM adapter, intent interpretation, inspector (Phases 08, 11).
- Standalone cancellation API; real providers/payments.

## 12. Common Mistakes / Traps

- Using a deferred unique constraint instead of an immediate partial unique index (replacement ordering breaks).
- Inserting the new confirmed row before superseding the old one.
- Storing proposals as reservations, or creating a reference before confirmation.
- Letting model output or a command confirm a booking; confirmation must be a decision response.
- Incrementing `trip.revision` on worker writes or more than once per request.
- Skipping the `SAVEPOINT` around reference generation, or treating every unique violation as a collision.
- Accepting an offer ID without snapshot membership/date/party/fingerprint checks.
- Forgetting `payloadHash` comparison on request dedupe, so a changed payload silently replays the old result.
- Cascading deletes on route changes instead of append-only history.

## 13. Completion Checklist

- [ ] Contracts compile strict; unknown keys rejected; commands/decisions match 04 section 6/7 exactly.
- [ ] Migration applies cleanly to an empty database and re-runs idempotently.
- [ ] Admission returns the exact 409 codes; partial unique indexes exist and are tested.
- [ ] BookingService is the only reservation writer; ownership + fingerprint checks tested.
- [ ] Reference format/collision/retry tested; replacement atomic ordering tested.
- [ ] Effect ledger replay tested; trip creation dedupe tested.
- [ ] T-UT-BOOK-01, T-IT-BOOK-01..06, T-IT-CONC-01 pass against real PostgreSQL.
- [ ] No payment/provider SDK; no file outside this phase's paths; no commit made.

## 14. Pasteable Executor Prompt

```text
Implement ONLY Phase03 against completed Phases01-02. Inspect/reuse existing code; no scaffolding reset.
Analyze -> implement -> verify, then STOP before Phase04; follow roadmap memory/safety/report rules.

Read first: AGENTS.md, agent-memory/index.md, invariants.md, docs/planning/04-domain-model.md (sections 1-3,
5-7, 9, 11), 09-booking-simulation.md (2-9), 02-architecture.md (5-7), 01-functional-requirements.md
FR-BOOK-1..7/FR-PRD-3, 11-testing-strategy.md T-UT-BOOK-01, T-IT-BOOK-01..06, T-IT-CONC-01. Use current docs.

Analysis (no code): list the tables/indexes, the admission transaction order, the confirmation ordering, and
the fixture rows you must insert so BookingService is testable before Phase 04. Confirm scope boundaries.

Implement exactly docs/planning/phases/phase-03.md sections 5-7. Real PostgreSQL, raw pg, strict Zod, no ORM, no
LLM. The generator/feasibility engine does not exist yet: fixture snapshots and approval rows stand in.

Verify: npm run db:migrate, npm run typecheck, npm run lint, npm run test:unit, npm run test:integration (real
PostgreSQL, two independent connections for the concurrency case), npm run build. Show real output.

Report changed files, AC-03-1..9 results, and any unresolved issue. Then STOP. Do not start Phase 04.
```
