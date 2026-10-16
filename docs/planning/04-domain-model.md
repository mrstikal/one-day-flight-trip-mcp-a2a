# Domain Model and Persistence Contracts

This document defines implementation contracts. TypeScript blocks describe schemas to implement later; they are not application modules.

## 1. Primitive Validation

Use Zod strict objects and explicit discriminated unions. Reject unknown keys at executable boundaries, rather than stripping arbitrary model-generated operations. UUIDs identify internal entities; imported geographic IDs retain their source namespace.

| Primitive               | Validation                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Entity ID               | UUID; never authorization by ID alone                                                |
| Geographic reference ID | `geonames:<numeric-id>`, `ourairports:<numeric-id>`, or documented curated namespace |
| Airport code            | Known three-letter uppercase IATA reference, not just a regex match                  |
| Country key             | Known admitted reference key; `XK` is an explicitly documented application extension |
| Local date              | Valid ISO `YYYY-MM-DD` parsed as a calendar date, not only regex-checked             |
| Instant                 | ISO UTC timestamp ending in `Z`                                                      |
| Time zone               | Known IANA zone resolved from offline reference data                                 |
| Money                   | Integer minor units, nonnegative, bounded; currency enum `EUR` for travel costs      |
| AI cost                 | Nonnegative USD decimal with fixed precision, not travel money                       |
| Coordinates             | Latitude -90..90, longitude -180..180, source and precision required                 |
| User first name         | Trimmed 1..60 characters, rendered as text                                           |
| Travelers               | Integer adults 1..6; children and complex room allocation are excluded               |
| Message                 | Trimmed 1..2000 characters; no raw HTML                                              |
| Source fingerprint      | SHA-256 of canonical, versioned, sorted-key input JSON                               |

All persisted JSON payloads have a `schemaVersion`. Imports and SQL reads are runtime-validated as well as writes. The initial currency is EUR for comparable costs; no online exchange-rate service or multi-currency arithmetic is introduced.

## 2. Enumerations and Preferences

```typescript
type TravelVariant = "one_night" | "two_nights";
type ServiceLevel = "budget" | "standard" | "luxury";
type ServiceKey = "hotel" | "breakfast" | "lunch" | "dinner";
type Meal = "breakfast" | "lunch" | "dinner";
type MealSelections = { breakfast: string; lunch: string; dinner: string | null };
type BookableKey = "flights" | ServiceKey;
type PreservableKey = BookableKey | "activities" | "events";
type ActivityPace = "relaxed" | "moderate" | "intensive";
type ActivityCategory = "culture" | "relaxation" | "entertainment";
type ActivityTag =
  | "museum"
  | "landmark"
  | "gallery"
  | "architecture"
  | "park"
  | "garden"
  | "waterfront"
  | "viewpoint"
  | "performance";
type WorkflowStatus =
  "idle" | "queued" | "running" | "waiting_user" | "blocked" | "ready" | "failed";
type BookingLifecycleStatus = "proposed" | "confirmed" | "superseded" | "cancelled";
type ReservationStatus = Exclude<BookingLifecycleStatus, "proposed">;
type ProposalStatus = "proposed" | "accepted" | "rejected" | "expired" | "superseded";
type OperationStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

interface TripPreferences {
  travelVariant: TravelVariant;
  defaultServiceLevel: ServiceLevel;
  serviceOverrides: Partial<Record<ServiceKey, ServiceLevel>>;
  activityPace: ActivityPace;
  interests: Record<ActivityCategory, number>; // Each integer 0..5; at least one positive.
  preferredActivityTags: ActivityTag[]; // Unique, maximum eight.
  minimumActivityCounts: Partial<Record<ActivityTag, number>>; // Each integer 1..7; explicit requirements.
  maxBudgetMinor?: number; // EUR, total for the entire party and trip.
}
```

Defaults: one adult, `two_nights`, `standard`, `moderate`, no service overrides, interests `{ culture: 3, relaxation: 2, entertainment: 1 }`, no minimum activity counts, no budget. The prepared demos use PRG; a normal user can choose any supported European origin.

Effective level is `serviceOverrides[key] ?? defaultServiceLevel`. Omission means inheritance; an explicit `standard` is still an override. Clearing an override removes the property. Neither operation changes an existing selection or reservation.

Travel dates are destination-local calendar dates: check-in `D-1`; checkout `D` for one night or `D+1` for two nights. Outbound arrival is `D-1`; return departure is `D` late for one night or `D+1` for two nights. UTC instants and local display zones remain separate.

Creation and route-date edits require sightseeing date between destination-local today + 2 and today + 365 days, using an injected clock. Before destination selection use the origin zone provisionally and revalidate when the city is known. Existing historical trips remain readable, but expired services cannot be newly confirmed; offer an explicit date/route-change review rather than silently moving the date.

Breakfast and lunch are required. Dinner may be `null` only when deterministic selected-flight/logistics assessment finds no feasible dinner slot; show the reason and exclude its price explicitly. A confirmed dinner cannot be removed this way. Normal curated demos provide dinner-compatible late returns.

The proposed lifecycle state lives in `selection_proposals`; no reservation row/reference is created before confirmation. `reservations` rows use only confirmed/superseded/cancelled states. The read projection combines proposal and reservation records into the required four-stage booking lifecycle without falsely calling a proposal a reservation.

## 3. Trip Aggregate

```typescript
interface Trip {
  id: string;
  sessionId: string;
  revision: number;
  userName: string;
  adults: number;
  originAirportId: string;
  destinationCountryKey: string;
  destinationCityId: string;
  sightseeingDate: string;
  preferences: TripPreferences;
  activeScenarioSnapshotId?: string;
  currentRouteValidationId?: string;
  currentScheduleValidationId?: string;
  currentItineraryId?: string;
  approvedItineraryId?: string;
  workflowStatus: WorkflowStatus;
  recoveryRequired: boolean;
  lastUnfinishedOperationId?: string;
  graphVersion: string;
  createdAt: string;
  updatedAt: string;
}
```

`workflowStatus` is a reconciled display projection, not the cursor. Revision advances on admitted business/decision requests only; technical retry reactivates the same existing operation without changing its inputs/revision. If a failed checkpoint is unfinished/uncertain, `recoveryRequired` blocks new ordinary requests. Selected offers are separate records; recommendations are not selections.

Changing route inputs requires an explicit impact preview if bookings or approved selections become incompatible. The accepted replacement/cancellation transaction preserves historical reservation rows and marks affected ones explicitly; it never deletes history or silently transfers them to the new city.

## 4. Two-stage Flight Validation

```typescript
type RouteReason =
  | "SAME_AIRPORT"
  | "SAME_CATCHMENT"
  | "GROUND_TRAVEL_PREFERRED"
  | "NO_REFERENCE_AIRPORT"
  | "TRANSFER_TOO_LONG"
  | "UNKNOWN_TIMEZONE"
  | "NO_PLAUSIBLE_ROUTE"
  | "SHORT_ROUTE_UNJUSTIFIED"
  | "MISSING_GEOGRAPHIC_EVIDENCE"
  | "DOOR_TO_DOOR_TOO_LONG";

type RouteValidation =
  | {
      status: "FEASIBLE";
      id: string;
      fingerprint: string;
      policyVersion: string;
      approvedAirportPairs: [string, string][];
      evidenceRefs: string[];
      expiresWithInputs: true;
    }
  | {
      status: "INFEASIBLE" | "UNDETERMINED";
      id: string;
      fingerprint: string;
      reasons: { code: RouteReason; explanation: string }[];
      alternatives: ("change_origin" | "change_destination" | "choose_ground_travel_elsewhere")[];
    };

type ScheduleReason =
  | "OUTBOUND_DATE"
  | "ARRIVAL_TOO_LATE"
  | "RETURN_DATE"
  | "RETURN_TOO_EARLY"
  | "CONNECTION_TOO_SHORT"
  | "CONNECTION_TOO_LONG"
  | "INVALID_DURATION"
  | "INVALID_TIMEZONE"
  | "TRANSFER_BUFFER"
  | "INSUFFICIENT_SIGHTSEEING"
  | "STALE_ROUTE_APPROVAL"
  | "NO_MATCHING_SCHEDULE"
  | "DOOR_TO_DOOR_TOO_LONG";

interface ScheduleValidation {
  id: string;
  status: "VALID" | "NO_VALID_OFFERS";
  routeValidationId: string;
  fingerprint: string;
  validCombinationIds: string[];
  rejected: { combinationId: string; codes: ScheduleReason[] }[];
  explanation: string;
}
```

The route fingerprint includes schema/rule/generator versions, reference snapshot version, origin airport, destination country/city, candidate destination airports and catchments, sightseeing date, travel variant, party size, transfer configuration, and synthetic-route policy version. Any changed input requires fresh Stage A validation, even when the route result might be the same.

The schedule fingerprint additionally includes stable scenario key, flight-domain version/hash, schedule-rule version, and combination content. Never bind it to the whole snapshot version: extending dinner inventory must not invalidate flights. Hotel/meal recommendation fingerprints similarly use only relevant domain hashes and effective preferences. Hotel-dependent logistics have a separate fingerprint including selected hotel, dates, meals, and return instants.

Provider/availability fingerprints include the relevant persisted behavior-overlay version. Re-arming a demo mode advances that version without changing inventory hashes. A changed availability/fault overlay cannot reuse a prior normal recommendation/StageB quote verdict; unrelated behavior domains and confirmed terms remain unchanged.

`FeasibleRouteApproval` is a server-created validated reference to a persisted `FEASIBLE` result, not a user/LLM boolean. Both the flight generator and booking service re-read it and compare the fingerprint with current domain inputs. A stale approval is rejected. `UNDETERMINED` never authorizes generation. See [feasibility rules](05-synthetic-data-design.md).

## 5. Scenario and Offer Contracts

```typescript
type ScenarioDomain =
  "flights" | "hotels" | "breakfast" | "lunch" | "dinner" | "activities" | "events";

interface ScenarioManifest {
  scenarioId: string;
  snapshotId: string;
  snapshotVersion: number;
  scenarioKey: string;
  seed: string;
  generatorVersion: string;
  fakerVersion: string;
  referenceVersion: string;
  generatedAt: string;
  destinationCityId: string;
  routeFingerprint: string;
  materializedDomains: ScenarioDomain[];
  domainVersions: Record<ScenarioDomain, number>; // 0 before materialization, >= 1 afterwards.
  domainContentHashes: Record<ScenarioDomain, string>;
}
```

Offers have immutable IDs within a persisted snapshot. Every offer records `scenarioSnapshotId`, `domainVersion`, `synthetic: true`, price in EUR, availability rules, and source/location precision. Real landmarks instead record `reference: true`, source attribution, synthetic opening-hour/pricing assumptions, and approximate visit duration.

Flight combinations contain outbound and return legs with known airport IDs, UTC departure/arrival, IANA zones, fictional airline, demo flight numbers, stop count, each connection duration, total elapsed duration, per-adult and party-total prices, and supported variant. A combination has at most one connection per direction.

Hotel offers contain category, dates, nights, adults/rooms, party-total price, rating, a safe/approximate anchor, center distance, check-in/out windows, luggage-storage support, and a demo label. Restaurant offers contain meal, level, cuisine, per-adult and party-total price, duration, windows, location anchor, and demo label.

Offer ID membership, snapshot version, category, dates, party size, and availability must be checked on selection and again on confirmation. An ID supplied by the LLM is only a reference to an existing authorized offer, never an offer definition.

Category eligibility is checked against the proposal's bound search/selection target, not blindly against the current global default. A same-category cheaper search may intentionally preserve a booked Luxury category while an inherited target preference is now Standard; that does not authorize a downgrade or invalidate a legitimate preserved-category proposal.

## 6. Executable Commands

The following is the exhaustive initial command family. Use a strict Zod discriminated union on `type`; each member has only its listed fields.

```typescript
type DomainCommand =
  | {
      type: "set_route";
      originAirportId?: string;
      destinationCityId?: string;
      sightseeingDate?: string;
      travelVariant?: TravelVariant;
    }
  | { type: "set_default_service_level"; level: ServiceLevel }
  | { type: "set_service_override"; service: ServiceKey; level: ServiceLevel | null }
  | { type: "set_activity_pace"; pace: ActivityPace }
  | {
      type: "set_interests";
      interests: Record<ActivityCategory, number>;
      preferredTags: ActivityTag[];
    }
  | { type: "set_activity_requirement"; tag: ActivityTag; minimumCount: number | null }
  | { type: "set_budget"; maxBudgetMinor: number | null }
  | {
      type: "find_alternatives";
      target: ServiceKey | "activities";
      objective: "cheaper" | "better_location" | "higher_rating" | "match_preferences";
      level?: ServiceLevel;
    }
  | { type: "propose_selection"; service: BookableKey; offerId: string }
  | { type: "set_program"; mealOfferIds: MealSelections; preferredActivityIds: string[] }
  | { type: "build_itinerary" }
  | { type: "retry_failed_domains" }
  | { type: "set_simulation"; mode: SimulationMode };

type SimulationMode =
  | "normal"
  | "no_flights"
  | "hotels_unavailable"
  | "provider_failure"
  | "invalid_itinerary"
  | "budget_conflict"
  | "preference_conflict";

type IntentResult =
  | {
      kind: "commands";
      commands: DomainCommand[];
      preserve: PreservableKey[];
      interpretation: string;
    }
  | {
      kind: "clarification";
      question: string;
      requestedCommands: DomainCommand[];
      preserve: PreservableKey[];
      options: { id: string; label: string; commands: DomainCommand[] }[];
    }
  | { kind: "unsupported"; explanation: string };
```

For `set_route`, require at least one changed field; resolve country from the known city rather than accepting contradictory country/city pairs. The intent adapter may emit at most four compatible commands. Reject duplicate/conflicting writes to the same field and operations that conflict with `preserve`. Atomic intent application changes preferences/search intent only; it does not batch-confirm bookings.

`set_simulation` is allowed only from the protected local/demo inspector, never from model output. Restrict the model-facing command schema to the supported conversational subset. `propose_selection` starts review, not confirmation. `find_alternatives: cheaper` uses the selected/confirmed party-total price and preserves that offer's category unless the user explicitly supplies `level`; without a selection, use the effective category and ask for a useful price baseline or explicitly shown budget cap. A global preference changed after booking does not implicitly authorize downgrading the booked category.

Explicit numeric activity requests persist through `minimumActivityCounts`, not only prose or interest weights. `set_activity_requirement` clears a requirement with `null`; relative counts are computed against current actual activity tags before storing an absolute minimum. A pace/time conflict is clarified or rejected, never resolved by silently dropping the count.

A clarification persists the original typed `requestedCommands` (0..4, not executed) and preservation scope separately from its alternative options. Thus a conflicting six-museum request remains machine-readable while the user decides, without prematurely changing preferences. A deterministic semantic conflict found after a `commands` result is converted into the same clarification form before any partial execution.

`set_program` cannot overwrite a confirmed meal selection or fixed reservation time. A differing meal ID is staged for explicit replacement, while compatible unbooked selections may change deterministically. A null dinner requires the specific feasibility result above, not a model preference or a cost-saving shortcut.

Confirmation, cancellation of confirmed reservations, and itinerary approval are decision responses, not LLM-executable commands. A model saying "confirmed" has no authority. All command refs and offered clarification options are schema-validated and bound to current trip inputs.

## 7. Decisions and Resume

```typescript
type DecisionKind =
  | "flight_choice"
  | "hotel_choice"
  | "program_choices"
  | "booking_confirmation"
  | "replacement_confirmation"
  | "route_change_confirmation"
  | "itinerary_approval"
  | "clarification"
  | "recovery";

interface PendingDecision {
  id: string;
  kind: DecisionKind;
  threadId: string;
  interruptId?: string;
  checkpointId?: string;
  graphVersion: string;
  createdRevision: number;
  sourceFingerprint: string;
  proposalId?: string;
  allowedOfferIds: string[];
  allowedOptionIds: string[];
  payloadHash: string;
  status: "pending" | "resolved" | "cancelled";
}

type PublicDecisionResponse =
  | { action: "choose_offer"; offerId: string }
  | { action: "confirm_booking"; proposalId: string; acceptedDemoDisclaimer: true }
  | { action: "reject_proposal"; proposalId: string }
  | { action: "decline_booking"; proposalId: string }
  | { action: "confirm_route_change"; proposalId: string; affectedReservationIds: string[] }
  | { action: "submit_program"; mealOfferIds: MealSelections; preferredActivityIds: string[] }
  | { action: "approve_itinerary"; itineraryId: string }
  | { action: "choose_option"; optionId: string };

type InternalDecisionResponse =
  PublicDecisionResponse | { action: "modify"; commandOperationId: string };

interface ResumeRequest {
  requestId: string;
  expectedRevision: number;
  decisionId: string;
  response: PublicDecisionResponse;
}

interface GraphResumeEnvelope {
  operationId: string;
  acceptedRevision: number;
  decisionId: string;
  response: InternalDecisionResponse;
}
```

The pending-decision table stores the safe payload and the actual checkpoint/interrupt binding surfaced by the worker. Resume is protected by the owner session, same-origin/CSRF validation, current revision, unguessable decision UUID, and exact pending-interrupt/fingerprint checks; an additional browser bearer token is unnecessary. The public schema excludes `modify`. The worker constructs the internal `modify` response and `GraphResumeEnvelope` only from an admitted operation; a browser cannot supply an operation identity or internal modification reference.

On resume, the pure interrupt node validates this trusted envelope against invocation context and returns the new operation ID/revision into serial graph state before any later effect. It resets per-operation counters/work scope, while preserving compatible artifacts. Otherwise a resumed graph would retain the old operation ID and mis-key booking effects. Recovery of the same operation retains its existing scope and counters rather than resetting them.

Validate a new answer against decision kind, allowed IDs, source fingerprint, proposal state, disclaimer acknowledgment, current ownership, current revision, and the actual pending graph interrupt. `createdRevision` is audit information, not the only freshness check. An unaffected preference request may change the revision while leaving a route approval valid; route changes never do. Recovery of an already admitted identical operation may read its stored decision/effect result even if that operation already resolved the decision; this exception never admits a new request or changed payload.

Each interrupt node contains one interrupt and no side effects before it. Decision/proposal creation happens in a preceding idempotent node. Stale, already-resolved, wrong-kind, foreign-thread, or replayed decisions cannot create a new reservation.

## 8. Itinerary and Validation

An immutable itinerary version contains the date/zone, source fingerprints, selected/booked offer refs, travel variant, pace, total party cost breakdown, and ordered events. Event kinds are `meal`, `activity`, `break`, `transfer`, `airport_buffer`, and `free_time`. Each has a UUID, UTC start/end, local display zone, location/route reference, optional offer/reference ID, physical-demand classification, cost inclusion key, and provenance.

The validator returns `{ status: "valid" | "invalid", errors, warnings, metrics, fingerprint }`. Machine-readable errors include overlap, opening-hours mismatch, transfer gap, airport buffer, insufficient sightseeing, missing meal, missing break, excessive walking, incompatible reservation, preference conflict, and budget exceeded. Errors block approval; warnings need an explicit visible explanation.

The planner chooses only candidate IDs and a proposed ordering/time allocation — and since 2026-10-14 visits are OPT-IN: it plans exactly the explicitly pinned activity IDs plus enough visits to satisfy the requested tag minimums, never opportunistic extras; a day without visits is the legitimate default. The instruction alone is not trusted in live mode: the worker deterministically strips every activity stop that is neither pinned nor needed for an outstanding tag minimum (`enforceOptInVisits`, before normalization and assembly), because the live model added unrequested visits despite the planner-v2 prompt. Deterministic code resolves costs, routes, immutable reservation times, and required transfers. A malformed or invented candidate is rejected before feasibility validation.

The required room between consecutive located stops (route estimate plus the pace transfer buffer) is domain arithmetic, never model arithmetic: a deterministic allowance pass widens a packed pair by shifting the later stop and everything after it, and never moves a meal past its fixed serving window (a confirmed reservation is pinned to its persisted time). When the later stop sits at its fixed window, the earlier located stop — and any planner blocks between the pair — is pulled earlier instead, bounded by its window start and the end of every earlier stop; a pair that still cannot fit is left to the validator. The pass resolves stop geometry through the same rules the assembly places (`proposedStopWindow`, 2026-10-13): a confirmed meal uses the offer's window start and fixed duration (never the planner's proposed slot), an unbooked meal uses the authoritative pace duration clamped into its window, an activity uses the candidate's fixed duration and is clamped UP to its simulated opening minute (2026-10-14 — the live planner reliably starts the morning visit right after breakfast even when the museum opens at 09:00, which failed both `opening_hours_mismatch` and the breakfast transfer room), and a filler block is capped at 180 minutes.

A planner-provided trailing filler block (a break or free-time block after the last located meal/activity) is padding, not content: it is trimmed to the return-buffer deadline and dropped when it would start inside the buffer window, and the airport buffer block then starts after whatever filler was kept. Only located content past the deadline raises `airport_buffer`.

## 9. SQL Inventory and Constraints

| Table                                 | Authoritative data and required constraints                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `anonymous_sessions`                  | UUID, token hash unique, CSRF hash, created/expiry; no raw cookie token                                                                  |
| `trips`                               | Session FK, strict preferences, revision >= 0, current refs, graph version; unique session/creation-request ID and creation payload hash |
| `reference_countries/cities/airports` | Source IDs, admitted scope, coordinates, zones, search indexes                                                                           |
| `reference_manifests`                 | Source URL, retrieval/version, SHA-256, license, transform version                                                                       |
| `route_validations`                   | Trip FK, fingerprint, policy version, typed outcome/evidence, immutable                                                                  |
| `schedule_validations`                | Route-validation FK, snapshot FK, typed rejection/valid IDs, immutable                                                                   |
| `scenario_snapshots`                  | Manifest and bounded inventory JSONB, content hashes, immutable; unique scenario/version                                                 |
| `recommendation_artifacts`            | Service/domain, input fingerprint, snapshot refs, ranked valid IDs, explanation                                                          |
| `trip_selections`                     | Unique trip/service, offer and snapshot refs, selected-by, active proposal/reservation refs                                              |
| `selection_proposals`                 | Before/after refs, dates, price, impact preview, payload hash, state/expiry                                                              |
| `reservations`                        | Trip/service, status, snapshot FK + validated offer ID, terms, reference unique, confirmation key                                        |
| `itineraries`                         | Trip/version unique, bounded event JSONB, validator/reviewer refs, status                                                                |
| `conversation_messages`               | Trip, sequence unique, role enum, content, interpretation/result refs                                                                    |
| `conversation_summaries`              | Versioned compact structured summary; no authoritative preferences                                                                       |
| `pending_decisions`                   | One pending decision per trip; kind, safe payload, checkpoint/interrupt binding, source fingerprint                                      |
| `workflow_operations`                 | Trip/request unique, payload hash, accepted revision, status, lease/fencing/attempts                                                     |
| `workflow_control_requests`           | Trip/control-request unique, payload hash, original operation FK, stored technical-retry result; no new business revision                |
| `workflow_effects`                    | Unique operation/node/scope; result and transaction-linked domain effect                                                                 |
| `execution_events`                    | Monotonic ID, trip/operation, strict public event payload, time; replay index                                                            |
| `llm_calls`                           | Role/model/prompt version, token/cost reservation/actual, attempts, safe status                                                          |
| `simulation_faults`                   | Trip/operation/domain/fault unique, persisted injection state/counters                                                                   |
| `rate_limit_buckets`                  | HMAC session/IP scope, endpoint bucket, expiry and atomic count                                                                          |
| `worker_heartbeats`                   | Worker/process identity, startup and last-seen times, version; readiness only, never a workflow cursor                                   |
| LangGraph-owned tables                | Official PostgresSaver schema; never hand-patch serialized checkpoints                                                                   |

Use SQL migrations with `pg`, foreign keys, check constraints, indexes on ownership/read paths, and transactional repository methods. Validate JSONB with Zod on both persistence boundaries; SQL constraints cover identities, uniqueness, state enums, and numeric invariants.

Required partial unique indexes:

- At most one queued/running workflow operation per trip.
- At most one pending decision per trip.
- At most one confirmed reservation per `(trip_id, service_key)`.
- A confirmation request/effect key has exactly one stored result.

Reservation replacement supersedes the previous confirmed row and confirms the new row in one transaction. Existing same-offer confirmation returns the active reservation even with a new request key. Booking history is never cascade-deleted by changing a route.

## 10. Compatibility and Retention

Persist `graphVersion`, state/schema versions, prompt versions, rule versions, generator/Faker versions, and reference versions. Restart uses the compatible compiled graph. A deployment with incompatible pending checkpoints refuses to run those threads with `GRAPH_VERSION_UNSUPPORTED` and exposes an explicit migration/reset procedure; it never guesses a checkpoint migration.

Anonymous sessions expire after 30 days of inactivity. Demo retention is 30 days after session expiry, with an explicit cleanup command for domain rows, events, and associated checkpoint threads. Do not silently delete a still-owned active trip. Checkpointer cleanup uses supported APIs for the pinned version and is covered by an integration test.

## 11. Mandatory Invariants

- A current route fingerprint is necessary before generating flights and before booking them.
- No rejected/undetermined route reaches hotel research, booking confirmation, or itinerary approval.
- Dates, nights, party totals, and selected variant agree across offers, bookings, and itinerary.
- Confirmed reservations change only through an authorized explicit decision.
- A local service override does not change the global default.
- A change to one component cannot mutate unrelated selection/reservation/content hashes.
- Derived artifacts are append-only versions; user-approved and current draft itineraries are distinguishable.
- Duplicate requests, node replay, and operation recovery have the same stored result.
- Neither graph state nor model output can bypass ownership, revision, decision, or domain checks.

See [test strategy](11-testing-strategy.md) for executable invariant and crash-window tests.

## Voice data addendum (2026-10-15)

- **Public message operation link.** `publicConversationMessageSchema` carries a required nullable `operationId` (legacy messages stay `null`; the link is never inferred from list position or timestamps). Projection maps the persisted value.
- **Speech DTOs.** Strict contracts for the operator speech profile file (`schemaVersion`, `pricingVersion`, `stt`, `tts`, `limits`), public voice capabilities, transcription response (`{requestId, text, mode}`), synthesis request (`{requestId, messageId}` only), and safe voice-call telemetry (kind, model, provider metadata, units, latency, status, reserved/actual USD - never audio, transcripts, reply text, keys, or generation ids).
- **`voice_calls` ledger (migration `0012-voice`).** Columns include `request_id`/`request_fingerprint`, `kind`, `model`, `gateway`, `provider_restriction`/`serving_provider`, nullable `operation_id`/`message_id`, pricing/normalization versions, `unit_kind`/`input_units`, `reserved_cost_usd`/`actual_cost_usd`, `latency_ms`, `generation_id`, `error_code`, `status` (`reserved|succeeded|failed|unknown_reserved|reconciled`), `cost_status`, and timestamps. Constraints: unique `(trip_id, request_id)`, TTS requires both message and operation links, units always travel with their kind, costs/units non-negative.
- **Request deduplication without durable results.** One attempt per `(trip, request_id)` under a short trip lock before any transport; an identical in-progress/uncertain request is refused (`VOICE_REQUEST_IN_PROGRESS`), a reused id with a different kind/fingerprint is a `CONFLICT`, and a finished request is never re-called (`VOICE_RESULT_EXPIRED`) because no audio or transcript result is retained.
- **Budget semantics.** The per-trip voice sum counts `actual_cost_usd ?? reserved_cost_usd`, so failures and uncertain charges keep their reservation until explicit reconciliation with billing evidence.
