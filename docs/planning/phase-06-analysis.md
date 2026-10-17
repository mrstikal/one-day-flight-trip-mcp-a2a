# Phase 06 analysis — Accommodation and City Guide research specialists

Status: implemented in this session (analysis produced before coding, updated with
decisions found during implementation). References: `ODTF_PLAN.md` §3.3–§3.5,
§3.9–§3.11, §3.13–§3.15 and the Phase 06 section.

## 1. Scope

Deliver the remaining two primary independent A2A services:

- **Accommodation agent** (`accommodation-agent`, `accommodation.recommend.v1`,
  port 4402/4432): hotel MCP query over the delegated frozen snapshot,
  deterministic eligibility/rank, optional governed comparison/explanation, and
  the genuine missing-tradeoff question (`TASK_STATE_INPUT_REQUIRED` +
  `AgentInputRequestV1`) with same-task continuation.
- **City Guide agent** (`city-guide-agent`, `city-guide.research.v1`, port
  4403/4433): exact requested meal/activity/event domains, bounded parallel
  queries (concurrency three), per-domain outcomes with retained successes.

Plus: persistent input generations, a shared SDK plumbing extraction (protocols),
cumulative limits for both skills, new least-privilege DB roles, and the four
planned integration suites.

Explicitly out of scope (per plan): coordinator/decision wiring, itinerary
proposal skill (Phase 08/10), fourth primary agent, agent-to-agent chains,
booking writes.

## 2. What already exists (verified)

- Contracts (`agent-artifacts.ts`, `agent-tasks.ts`): `AccommodationRecommendationsV1`,
  `CityGuideRecommendationsV1`, `AgentInputRequestV1`, continuation payload,
  task limits, safe error categories — complete since Phase 03, no changes needed.
- MCP host (Phase 04): `odft-travel-data` with `search_hotels`,
  `search_restaurants`, `search_attractions`, `search_events`, per-identity
  endpoint + domain allowlists (`TRAVEL_DATA_DOMAIN_ALLOWLIST`), delegation
  authorization with exact snapshot/domain, `levelOverride`/`objective` from the
  delegation scope applied inside the read service (level, dates, luggage,
  cheaper override), read-only fault overlay, `domainHash` per page.
- Persistence: `protocol_task_control` already carries `input_count`,
  `input_generation`, cumulative counters; `upsertTaskControl`/`setTaskState`/
  `addTaskCounters` are generation-aware; admission middleware already increments
  `input_generation` on a continuation message and keeps `input_required` as a
  resting state during restart reconciliation.
- Domain helpers: `rankDeterministically` (price then id),
  `acceptRecommendationReorder`, `effectiveLevel`, gate/retry classification.
- Phase 05 flight agent: the executor structure to generalize (admission →
  delegated authority → counted MCP reads → deterministic rank → optional
  governed reorder → validated artifact → lifecycle), the delegated ledger and
  the `createDelegatedFlightRanker` paid path.

## 3. Shared SDK plumbing (new `packages/protocols/src/a2a/executor-support.ts`)

One module, SDK-typed, reused by all three executors without coupling them:

- message/part helpers (`agentMessage`, `dataPart`, `dataPartOf`);
- `safeFailureCode(error)`: extracts a code from any error whose `code` is one of
  the contracts' `agentFailureCategory` values (duck-typed; protocols must not
  import `@odft/services`/`@odft/ai`), else `INTERNAL_ERROR`;
- `createTaskClock({ pool, agentIdentity, taskId, skillId, startedAt })`:
  loads the allowance, exposes `refresh()` (re-load), `assertActive()` (deadline
  check), `deadlineMs`, and `assertNow({ mcpInvocation })` combining both;
- `countedToolCall({ mcp, clock, service, name, arguments })`: asserts the MCP
  allowance **before** the call, performs it, counts it (retries included) —
  the single place the 4/8 invocation caps are enforced;
- `loadClaimedAuthority({ pool, agentIdentity, delegationId, taskId, domain, snapshotId })`:
  load → claim (first use) → `assertAuthorityCovers`;
- `createFailurePublisher({ eventBus, admission, task, messageId })` →
  `{ publishFailure(code, reason), publishCancelled(), publishInputRequired(...),
     cancellationRequested() }`;
- `publishStatus(eventBus, task, state, text?, metadata?)`, `publishArtifact(...)`.

The flight executor is refactored onto this module (behavior and Phase 05 tests
unchanged), so the new executors stay thin and independently implemented.

## 4. Input-required and continuation (persistent generations)

- Migration `0015-agent-input.sql` adds `input_request_id`, `input_request_hash`,
  `input_expires_at` to `protocol_task_control`; the two new agent roles are
  created by `scripts/setup-protocol-roles.ts` with the same least-privilege
  profile as `odft_flight_agent` (task tables + counters + delegated reads +
  ledger EXECUTE, no domain writes).
- `task-control.ts` gains `TASK_LIMITS` for both skills (60 s/4/2/0.10 and
  90 s/8/2/0.10, two inputs each) and:
  - `recordInputRequest(pool, {agentIdentity, taskId, requestId, requestHash,
    expiresAt})`: sets `input_required` + pending-request columns + counts one
    input (cap two, `assertAllowance({input:true})` before asking);
  - `consumeInputContinuation(pool, {agentIdentity, taskId, inputGeneration,
    answerRequestId})`: a compare-and-swap that requires the admission's
    incremented generation and the pending request id and must not be expired
    (`INPUT_EXPIRED`); on success the pending columns are cleared exactly once.
    The stored request hash is correlation evidence only (the contract's
    continuation payload carries no hash field).
- The executor publishes the question as `AgentInputRequestV1` (artifact) plus
  `TASK_STATE_INPUT_REQUIRED`, then `markSettled('input_required')`; human
  waiting is excluded from active time (the clock accrues only around work).
- A continuation re-runs the same invocation path with `request.continuation`
  set: it must validate before any work; a wrong/expired/duplicate answer fails
  safely (`INVALID_ARTIFACT`/`INPUT_EXPIRED`) and never re-asks. A replayed
  message id is answered with the persisted canonical task by admission (no
  executor work).
- Restart reconciliation keeps failing only `submitted`/`working` tasks; an
  `input_required` task survives a restart and its pending request row remains
  valid (tested).

## 5. Genuine hotel tradeoff question (deterministic rule)

Asked only when the request is a **cheaper** search (`searchObjective:"cheaper"`)
and the eligible hotel set is genuinely ambiguous:

- `cheapest` = lowest `partyTotalMinor`. Ambiguous when a candidate within a
  50 % price premium of the cheapest is at least 1.5 km closer to the centre AND
  at least 40 % closer in relative distance (distance ≤ 0.6 × the cheapest's),
  so the cheaper and the central option are both genuinely viable. Implemented
  as `TRADEOFF_PREMIUM_RATIO = 0.5`, `TRADEOFF_MIN_DISTANCE_KM = 1.5`,
  `TRADEOFF_DISTANCE_RATIO = 0.6` in the accommodation executor.
- A fully specified request (preserve level, or an unambiguous cheaper set)
  completes without a question (tested both ways).
- Options are finite and stable: `cheapest` ("Lowest total price") and
  `central` ("Closest to the centre"); `requestId` is stable per task/generation,
  `requestHash` is the canonical hash of the question payload, expiry 24 h.
- The answer selects the deterministic order: `cheapest` → price/id,
  `central` → distance/price/id among the eligible candidates; the reorder rule
  stays `acceptRecommendationReorder`-compatible (the paid comparison may still
  only permute supplied ids).

Fixture data: the deterministic seed already contains such a pair at the standard
level (cheapest ≈ 22128 at ≈ 3.05 km; ≈ 31306 at ≈ 1.40 km, a ≈ 41 % premium),
so the test requests `cheaper` without any `levelOverride` and asserts the
question plus the chosen-order artifact against the real snapshot.

## 6. Ranking, artifacts and paid comparison

- Accommodation: MCP facts are already eligibility-filtered (level, dates,
  party, luggage, objective override). Deterministic order: `rankDeterministically`
  (price then id). Optional governed comparison/explanation reuses the
  recommendation role (v1 prompt; `target:"hotel"`; the role-context union
  already accepts it) through a **generalized** delegated offer ranker in
  `packages/services/src/ai/runtime.ts`:
  `rankDelegatedOffers(pool, config, deps, { rolePrompt, context, allowedIds,
  deterministicOrder, authority, effectScope, signal, limits })`, with
  `createDelegatedFlightRanker` kept as a thin wrapper (no behavior change).
  Validation is permutation/subset of supplied ids; invalid output → deterministic
  order + `findings` note; settlement records the real validation status.
- City Guide: per-domain deterministic ranking only (meals via
  `rankDeterministically`, attractions keep the preference/reference order the
  MCP already applies, events by id). No LLM in Phase 06; the 2-attempt budget is
  documented as a ceiling.
- `CityGuideRecommendationsV1.outcomes[].inputFingerprint` comes from the task
  request's `queryContext.domainInputFingerprints[domain]` (produced by the
  coordinator via `loadTripResearchInputs`); `null` when absent — never invented.
- `simulatedFailure`/`reason` come from the MCP page (`providerStatus`,
  `simulated` flag added to the travel-data page for overlay outcomes);
  `rankedOfferIds` are always the returned fact ids (membership enforced).
- Accommodation artifact `comparisons[].distanceKm` needs the hotel's
  centre distance: `HotelCandidateFact` and the `search_hotels` tool output gain
  `centerDistanceKm` (an existing deterministic snapshot fact, additive).

## 7. Parallel research and partial outcomes

- City Guide runs the requested domains with a concurrency-three semaphore and
  retains per-domain successes when a sibling fails; the task completes with the
  artifact when at least one domain is `ok`, otherwise fails
  (`MCP_UNAVAILABLE`/`AGENT_UNAVAILABLE`). No all-domains-success barrier.
- The two new agents use `fileParallelism`-independent real HTTP servers; the
  parallel-research suite starts both tasks over streaming and proves overlapping
  execution windows (client-observed event timestamps plus a DB poll showing both
  control rows `working` concurrently), with a documented test-only step-delay
  hook (`ODFT_<AGENT>_STEP_DELAY_MS`, same spirit as the Phase 05 crash hook).

## 8. Tests

- `accommodation.test.ts`: card/artifact validation, hotel dates/category,
  cheaper objective with delegation `levelOverride`, ranking membership,
  fully-specified request completes without a question, write denial (agent role
  cannot touch hotel offers/selections).
- `city-guide.test.ts`: card, exact requested-domain scope, per-domain outcome
  statuses, ranking membership, partial failure with retained successes,
  unauthorized domain (delegation scope) refused.
- `input-required.test.ts`: genuine question (ambiguous cheaper), continuation
  completes the same task, duplicate message id → persisted replay, invalid
  option → safe failure, expired request → `INPUT_EXPIRED`, revoked delegation →
  `DELEGATION_REVOKED`, restart while awaiting input keeps `input_required`,
  cumulative caps unchanged across the continuation.
- `parallel-research.test.ts`: simultaneous submissions, overlapping windows,
  both artifacts validated.
- Paid-path regression for the generalized ranker: the Phase 05
  `delegated-governance` suite gains a hotel-context scripted case.

## 9. Risks and mitigations

- **Fabricated questions**: a strict deterministic rule + "fully specified never
  asks" tests; the question is only exposed for the cheaper objective.
- **Budget reset on continuation**: counters live on the control row and are
  never reset; the continuation re-loads the allowance and only gets the
  remainder (tested).
- **Serialized research**: city-guide domains run behind one semaphore(3) and the
  raw durations are asserted, not assumed.
- **Lost successes**: outcomes are per-domain; a failing sibling never discards a
  completed domain, and the artifact is published with all outcomes (tested).
- **Double ledger reservation**: the generalized ranker keeps the Phase 05
  contract (governor-free adapter, `maxAttempts: 1`, one reservation per attempt).
