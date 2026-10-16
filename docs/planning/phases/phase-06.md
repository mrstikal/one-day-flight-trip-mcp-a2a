# Phase 06 - Welcome, Destination, Origin/Date/Variant Wizard, Flight Gating, and Booking UI

Status: implementation plan (planning only). No application code or test exists on 2026-10-10. All code blocks are
future targets. This phase ships the real wizard steps 0-3, the flight gating UX, flight choice, proposal, and
explicit booking confirmation. It does NOT ship hotel/meal/activity UI, itinerary, chat interpretation, the map,
or the inspector.

## 1. Goal

Deliver a working graphical planning path: create an anonymous session, complete the welcome and
country/city/origin/date/variant wizard as a local draft, create the trip, then show flight gating (Stage A +
Stage B), let the user choose a flight, review a proposal, and confirm a simulated flight booking. Owns
FR-PREF-1/2, FR-UI-1 (wizard subset), FR-FEAS-3/6 (rejection UX), FR-BOOK-1/6 (flight booking surface), and
FR-PRD-2.

## 2. Prerequisites

- Phases 02-05 complete: reference lookup, booking service, deterministic feasibility/generator, worker + graph +
  BFF admission/resume + session/CSRF + SSE.
- Phase 01 commands available; the local stack runs via `npm run dev` and `docker compose up -d postgres`.
- Fixture AI mode (`AI_MODE=fixture`) is the default; this phase makes no OpenRouter call.

## 3. Source Inputs (authoritative)

- docs/planning/08-frontend-ux.md sections 1-6, 11-14 (principles, visual tokens, shell, wizard steps,
  preference controls, accessibility, responsive, state/error presentation).
- docs/planning/09-booking-simulation.md sections 6, 10 (confirmation flow, booking UI).
- docs/planning/02-architecture.md section 8 (read API and streaming, `202` semantics).
- docs/planning/07-conversation-and-intents.md sections 2-3, 7 (request envelopes, interpretation rules, outcome
  language) for the acceptance of shared commands; the intent LLM call itself is Phase 08.
- docs/planning/01-functional-requirements.md FR-PREF-1/2, FR-UI-1, FR-FEAS-3/6, FR-BOOK-1/6, FR-PRD-2.
- docs/planning/11-testing-strategy.md T-E2E-01/02 (subset through flight confirmation), T-E2E-13,
  T-UT-PREF-01..03, T-UT-PRD-01, Phase 06 gate.
- Read current docs; older comments are not authoritative.

## 4. Binding Decisions (do not re-decide)

- Steps 0-2 (welcome, country, city) are a LOCAL DRAFT in the browser; no tripId exists before the city step.
  `POST /api/trips` receives the complete validated welcome+destination draft plus `requestId` and creates the
  trip at revision 1. Later route edits use `/api/trips/:id/commands` with `expectedRevision`. Never create a
  trip before the destination city is chosen.
- A handler `202 Accepted` means the command was queued, never success. The UI shows `Accepted - planning in
  progress` and only claims success after the persisted outcome/SSE event arrives. No fake offer cards or
  placeholder prices.
- Flight gating is absolute: an `INFEASIBLE` or `UNDETERMINED` route renders a structured decision card with
  reason codes, a plain explanation, and alternatives (`change origin`, `change destination`, `choose ground
  travel elsewhere`); the wizard does not advance and never displays fabricated flights. The UI must not claim
  the destination is unreachable by ground.
- Welcome choice is provisional while availability is unknown. Never promise Economy before its own StageB passes; no-offer results show a reason and an explicit two-night request with fresh StageA. Later one-night hotels require luggage storage.
- Flight choice is a decision (`choose_offer`) that stages a proposal; only an explicit `confirm_booking` decision
  with `acceptedDemoDisclaimer: true` creates the reservation. A model or UI text saying "confirmed" has no
  authority. The confirmation dialog requires ticking `I understand this is a simulated booking.`
- The permanent disclaimer and the confirmation sentence are exact ASCII strings and appear verbatim:
  `DEMO APPLICATION - No real reservations are made and no payments are processed.` and
  `Simulated booking - not valid for travel, accommodation, or restaurant admission.`
- The client computes no prices, feasibility, pace feasibility, or booking decisions; it renders the authorized
  server projection. `MAP_TILE_URL` is public and must contain no secret; tiles are not configured in this phase.
- The persistent assistant rail may be present as a shell, but chat interpretation is Phase 08; this phase's path
  is graphical controls only. UI controls and chat will later share one command dispatcher (Phase 08).
- On `409 STALE_REVISION` the UI refreshes the projection and re-presents the current revision; it never replays
  the old command. On `409 OPERATION_IN_PROGRESS` the UI waits for the current operation.

## 5. Detailed Ordered Steps

1. Build the app shell and design-system tokens: header (`AI Travel Planner`, `Hello, {firstName}`, status chip),
   permanent demo banner + footer, and the `@theme` CSS tokens from 08 section 2. Verify contrast in Phase 01
   terms; change only a pair that demonstrably fails.
2. Implement the shared WAI-ARIA APG combobox used by country, city, and airport inputs (roles,
   `aria-expanded`, `aria-activedescendant`, typeahead, Escape/Arrow/Enter, `aria-live` result count).
3. Implement session bootstrap: call `POST /api/session`, hold the CSRF token in memory, and render the AI-mode
   banner (`Deterministic fixture mode - no live AI calls`).
4. Implement wizard step 0 (welcome) and steps 1-2 (country, city) as a local draft with in-memory unsaved edits.
   Validate name (1..60), sightseeing date window, adults 1..6, variant, default service level, activity pace,
   optional budget.
5. Implement `POST /api/trips` submission of the complete draft; render the trip projection and the queued
   operation banner; handle duplicate-creation and stale-revision responses.
6. Add a separately registered production travel-graph prefix to the worker: load_context, typed apply_commands, validate_route, generate_flights, validate_schedules, prepare_decision, pure await_decision, apply_decision, stage_selection, commit_booking, publish_summary. Wire complete-input POST /api/trips. After flight confirmation stop at an honestly partial phase boundary until Phase07; no full-itinerary-ready claim. Keep the Phase05 harness test-only.
7. Implement the flights step: render gating results (route FEASIBLE -> generated flights; INFEASIBLE/UNDETERMINED
   -> decision card), the `one_night` availability gate, and flight combination cards (airline, demo flight
   number, airports, local+UTC times, duration, stops, total travel time, party-total EUR, variant badge).
8. Implement the `flight_choice` decision (choose an offer -> proposal with before/after and price delta) and the
   `booking_confirmation` dialog with the disclaimer checkbox and explicit confirm; render success with the
   `DEMO-FLT-...` reference only after the persisted outcome.
9. Implement the status/error presentation table from 08 section 14 (`idle`, `queued`, `running`, `waiting_user`,
   `blocked`, `ready`, `failed`) and the SSE-to-polling fallback.
10. Implement accessibility (focus management, live regions, target size, reduced motion) and responsive layouts
   (desktop wizard + assistant rail; mobile single column).
11. Write the tests in section 10 (wizard E2E subset, rejection UX, disclaimers, keyboard).

## 6. Concrete Target Paths

```text
apps/web/src/app/(wizard)/page.tsx
apps/web/src/app/page.tsx  # move root page into route group, do not leave two / routes
apps/web/src/app/(wizard)/destination/page.tsx
apps/web/src/app/trips/[id]/{flights,summary}/page.tsx
apps/web/src/app/layout.tsx
apps/web/src/app/globals.css                      # Tailwind 4 @theme tokens, no JS config
apps/web/src/components/{AppShell,Combobox,DecisionCard,StatusChip,DisclaimerBanner}.tsx
apps/web/src/components/wizard/{WelcomeStep,CountryStep,CityStep,FlightCard,FlightGating,BookingDialog}.tsx
apps/web/src/lib/{session-client,use-trip-projection,use-sse,decision-client}.ts
apps/web/src/lib/format/{money,datetime}.ts
apps/web/src/app/api/trips/route.ts
packages/workflow/src/travel/{graph,state}.ts
packages/workflow/src/nodes/{load-context,apply-commands,validate-route,generate-flights,validate-schedules,prepare-decision,await-decision,apply-decision,stage-selection,commit-booking,publish-summary}.ts
apps/worker/src/driver.ts, packages/workflow/src/index.ts  # real flight prefix
tests/e2e/wizard-flights.spec.ts              # T-E2E-01/02 subset through flight confirmation
tests/e2e/route-rejection.spec.ts             # T-E2E-13
tests/unit/ui/{preferences-form,flight-format}.test.tsx  # T-UT-PREF-01..03 subset, T-UT-PRD-01
```

## 7. Functions and Interfaces to Implement

```typescript
// client data hooks (server projection is the only source of truth)
useSession(): { csrfToken: string; ensureSession(): Promise<void> };
useTripProjection(tripId: string): { projection: TripProjection; refresh(): void };
useSseEvents(tripId: string, after?: string): { events: ExecutionEvent[]; reconnecting: boolean };

// wizard draft (local only; no tripId before city)
submitTripCreation(draft: ValidatedCreationInput): Promise<{ tripId: string; operationId: string; revision: number }>;
submitCommand(tripId: string, input: CommandInput, expectedRevision: number): Promise<OperationQueued>;
submitResume(tripId: string, decisionId: string, response: PublicDecisionResponse, expectedRevision: number): Promise<OperationQueued>;

// pure formatting helpers (tested)
formatMoney(minorUnits: number, adults: number): string;   // EUR + "Total for N adults"
formatLocalDateTime(instant: string, zone: string): string; // explicit zone label

// components
<Combobox /> <FlightGating /> <FlightCard /> <DecisionCard /> <BookingDialog /> <DisclaimerBanner />
```

## 8. Outputs / Deliverables

- Working wizard steps 0-3 with session bootstrap, local draft, trip creation, and route-edit commands.
- Flight gating UI (FEASIBLE/INFEASIBLE/UNDETERMINED) with typed reason codes and alternatives.
- Flight choice decision, proposal review, and explicit booking confirmation with demo reference handling.
- Status/error presentation, SSE with polling fallback, accessibility, and responsive layouts.
- Verbatim disclaimer strings on all routes and confirmations.
- Tests listed in section 10.

## 9. Measurable Acceptance Criteria

- AC-06-1: no tripId exists before the city step; `POST /api/trips` creates the trip at revision 1 and dedupes
  duplicate creation.
- AC-06-2: a `202` response renders the queued banner and never a success state; success appears only after the
  persisted outcome.
- AC-06-3: PRG -> Ceske Budejovice shows `GROUND_TRAVEL_PREFERRED`, states the destination is not claimed
  unreachable by ground, offers alternatives, and displays no flight offers or booking controls.
- AC-06-4: provisional welcome preference is not availability; actual offers require StageB, rejected Economy cannot advance, and fallback revalidates the changed variant.
- AC-06-5: flight confirmation is blocked without the disclaimer checkbox; a `confirm_booking` decision creates
  exactly one reservation; the `DEMO-FLT-` reference appears only on success.
- AC-06-6: both disclaimer sentences are present verbatim on every route and in the confirmation dialog.
- AC-06-7: the client performs no price/feasibility/booking computation; all values come from the server
  projection.
- AC-06-8: stale/busy/recovery conflicts refresh or wait without replaying the old command.
- AC-06-9: keyboard-only completion of the flight-path subset works on desktop and mobile viewports.
- AC-06-10: no OpenRouter call occurs in fixture mode; the AI-mode banner is visible.

## 10. Commands and Tests

```text
docker compose up -d postgres
npm run db:migrate
npm run checkpointer:setup
npm run dev
npm run typecheck
npm run lint
npm run test:unit          # T-UT-PREF-01..03 subset, T-UT-PRD-01
npm run test:e2e           # T-E2E-01/02 subset through flight confirmation; T-E2E-13
npm run build
```

E2E runs with `AI_MODE=fixture` and makes no OpenRouter call. Subsequent phases add the remaining E2E cases; this
phase does not claim hotel/meal/itinerary/inspector tests. If any Phase 01 package fails resolution or a
production build fails, report the concrete incompatibility instead of silently substituting a version.

## 11. Explicit Out of Scope

- Hotel, meal, activity/entertainment UI (Phase07); map arrives in Phase10.
- Itinerary timeline, planning/review loops, approval action (Phase 10).
- Real chat interpretation / LLM adapter / assistant conversation (Phase 08).
- Execution inspector and selective-replanning UI (Phase 11).
- Tile configuration, real providers, payments.

## 12. Common Mistakes / Traps

- Creating a trip before the destination city is chosen, or persisting a partial welcome draft as trip truth.
- Rendering success from a `202` or showing placeholder/fake offer cards.
- Fabricating flights to fill the wizard when a route is INFEASIBLE/UNDETERMINED.
- Offering Economy when no Stage B schedule passes, or ignoring the luggage-storage requirement.
- Computing prices/feasibility client-side, or trusting a "confirmed" model/UI string as a booking.
- Rotating the session cookie on reload (racing concurrent tabs), or leaking secrets into `MAP_TILE_URL`.
- Replaying a stale command automatically after `409` instead of refreshing and re-presenting.
- Missing the verbatim disclaimer sentences, or mutating an English string.

## 13. Completion Checklist

- [ ] Session bootstrap + AI-mode banner + CSRF handling implemented.
- [ ] Local draft wizard steps 0-2; no tripId before city; trip creation dedupe.
- [ ] Flight gating (FEASIBLE/INFEASIBLE/UNDETERMINED) UX with reason codes and alternatives.
- [ ] `one_night` availability gate; flight cards with party totals and variant badge.
- [ ] Flight choice decision, proposal review, explicit confirmation dialog with disclaimer checkbox.
- [ ] Status/error presentation, SSE + polling fallback, accessibility, responsive.
- [ ] Both disclaimer sentences asserted verbatim.
- [ ] T-UT-PREF-01..03 subset, T-UT-PRD-01, T-E2E-01/02 subset, T-E2E-13 pass; typecheck/lint/build pass.
- [ ] No file outside this phase's paths; no commit made.

## 14. Pasteable Executor Prompt

```text
Implement ONLY Phase06 against completed Phases01-05. Add the production flight graph prefix; reuse all
existing domain/services/driver. Analyze -> implement -> verify, then STOP before Phase07.

Read first: AGENTS.md, agent-memory/index.md, invariants.md, docs/planning/08-frontend-ux.md (1-6, 11-14),
09-booking-simulation.md (6, 10), 02-architecture.md (8), 07-conversation-and-intents.md (2-3, 7),
01-functional-requirements.md FR-PREF-1/2, FR-UI-1, FR-FEAS-3/6, FR-BOOK-1/6, FR-PRD-2, 11-testing-strategy.md
T-E2E-01/02 subset, T-E2E-13, T-UT-PREF-01..03, T-UT-PRD-01. Use current docs, not older comments.

Analysis (no code): confirm the local-draft-before-trip rule, the 202 semantics, the gating decision-card
behavior, the Economy availability gate, and that the client computes no prices/feasibility. Confirm the
assistant chat interpretation is deferred to Phase 08.

Implement exactly docs/planning/phases/phase-06.md sections 5-7: app shell + tokens, combobox, session bootstrap,
steps 0-3 wizard, flight gating, flight choice + proposal, explicit confirmation dialog, status/error and SSE
fallback, accessibility/responsive, and the tests. No hotel/meal/activity UI, no itinerary, no chat interpretation,
no inspector.

Verify: docker compose up -d postgres; npm run db:migrate; npm run checkpointer:setup; npm run dev; npm run
typecheck; npm run lint; npm run test:unit; npm run test:e2e (AI_MODE=fixture); npm run build. Show real output
including the rejection UX and verbatim disclaimers.

Report changed files, AC-06-1..10 results, and any unresolved issue. Then STOP. Do not start Phase 07.
```
