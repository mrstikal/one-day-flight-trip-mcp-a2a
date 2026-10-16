# Critical Architecture Review

Review date:2026-10-10. Scope:planning/specification correctness, not application/runtime acceptance.

## 1. Method and Outcome

The baseline, brief, mandatory addendum, canonical specifications, ADRs and phase dependencies were reviewed. Primary LangGraph JavaScript APIs/packages, geographic dataset terms and OpenRouter pricing/routing semantics were checked. A closed-proposition Decider pass supplied risk signals; an independent generative review verified evidence and consequences. Signals were not treated as proof or user approval.

Four material specification gaps were confirmed and corrected below. Integration additionally resolved resume-operation identity, failed-work retry semantics, atomic replacement ordering, quote-versus-snapshot fingerprints, phased graph wiring, and map/inspector sequencing. Mechanical link/schema-reference/fence/phase/diagram validation is separate from runtime proof.

An independent targeted recheck confirmed all four findings closed. Its remaining traceability correction was applied:the realized-duration regression maps to FR-FEAS-9, now explicitly including the StageB600-minute cap. No probability score is acceptance evidence.

The accepted architecture has no deliberately deferred major design choice. It is ready for Phase01 implementation, not already implemented. Test IDs describe future obligations; no application build, PostgreSQL worker test, browser journey, or genuine OpenRouter travel-planning call has run in this planning task.

## 2. Independent Findings and Corrections

| Finding | Failure before correction | Final decision and evidence obligation |
| --- | --- | --- |
| R1 Ground-first ordering | Missing/ineligible destination airports could yield UNDETERMINED before PRG/Budejovice's required GROUND_TRAVEL_PREFERRED result | Ordered StageA rule, independently computable245-minute optimistic air-process lower bound versus180-minute reviewed ground; test with all eligible destination candidates removed |
| R2 Realized travel duration | StageA600-minute estimate did not constrain the actual generated combination | StageB independently computes door-to-door with actual first-to-last elapsed, each connection once; <=600 each way or typed DOOR_TO_DOOR_TOO_LONG; T-REG-FEAS-06a |
| R3 Effective AI pricing | Base token rates omitted per-request fees and published peak/time/context tariff overrides | requestPriceUsd, worst normalized rates across all tariffs/matched endpoints, known additive charges, per-operation refresh, hard prompt/completion/request routing caps, refuse ambiguity; T-IT-COST-04 |
| R4 Typed outcomes | Some route table rows said only block/reject/limit without mapping the declared reason union to status | Every RouteReason maps to FEASIBLE/INFEASIBLE/UNDETERMINED; explicit pair aggregation and rule priority in data specification |

Authoritative changes:[route rules](05-synthetic-data-design.md#5-stage-a-deterministic-route-feasibility), [schedule validation](05-synthetic-data-design.md#6-stage-b-flight-generation-and-schedule-validation), [reason schemas](04-domain-model.md#4-two-stage-flight-validation), [pricing governance](06-ai-agent-design.md#8-durable-call-budgets-and-observability), and [tests](11-testing-strategy.md).

No unsupported claim about a particular airport's current operating schedule/type is needed to prove R1. The reviewed-ground comparison is a demo policy using real geography and conservative process assumptions, not live rail/air timetable advice.

## 3. Strengths

- LangGraph genuinely owns conditional gates, Send fan-out/join, bounded revisions, one replay-safe human interrupt, and after-END re-entry; it is not a decorative linear wrapper.
- Deterministic domain authority is separate from four small AI roles; bookings, prices, safety, identifiers and ownership cannot be decided by model prose.
- PostgreSQL alone provides domain/query/checkpoint/job/event persistence; no extra broker/HTTP backend/payment/travel platform.
- Explicit request/effect keys and active-slot uniqueness reconcile at-least-once execution rather than claiming exactly-once nodes.
- Current-input approvals and domain-specific quote hashes prevent restored Rome approvals or dinner snapshot changes from corrupting unrelated route/booking state.
- Reference facts and fictional offerings have distinct provenance; imported geography has known scope/terms and unknown evidence is conservative.
- Component/pace/interest/count preferences are separate; confirmed terms remain fixed and the UI shows divergence between desired level and booked level.
- Credential-free fixtures make failures reproducible while live AI remains explicitly distinguishable and acceptance-gated.

## 4. Weaknesses and Tradeoffs

| Tradeoff | Cost or limitation | Why retained |
| --- | --- | --- |
| Separate worker | Second application process and health/lease/shutdown code | Request lifetime cannot guarantee required restart/interrupt durability |
| Fenced saver wrapper | Extra short DB transaction/gate and lock/pool tests | Domain fencing alone cannot stop stale official-saver writes after lock loss |
| Domain/checkpoint dual authority | Explicit reconciliation/refs and effect ledger | Domain constraints/read ownership and checkpoint execution position are different concerns |
| SQL job table | Small claim/retry/control logic maintained locally | Avoids Redis infrastructure while preserving durable graph invocation |
| Rich strict contracts | Up-front schema/semantic validation work | Prevents malformed/model-invented operations and makes the smaller implementation model's task determinate |
| Conservative missing-data policy | Some real cities/air routes remain unsupported | Prefer a visible limitation over fabricated practical flight claims |
| Reference import/licenses | Offline assets, timezone derivation/ODbL compliance, curated review | Broad consistent European search without commercial APIs |
| Fixture-first testing | Does not prove genuine model quality/latency | Deterministic orchestration evidence is reproducible; live smoke is a separate requirement |
| Low AI budgets | Expensive configurations or peak rates may be rejected | Intentional fail-closed bounded demo cost rather than hidden overruns |

## 5. Complexity Assessment and Simplifications

The highest implementation complexity is durability, not agent conversation. Keep one worker driver, one strict command path, one generic interrupt node, one keyed research reducer and one confirmation transaction. Do not add supervisors, response/summarizer agents, databases, ORM models mirroring every checkpoint, workflow engines, brokers, or speculative provider integrations.

Keep the saver guard narrowly around official write methods; do not fork checkpoint serialization or DDL. Keep fault modes as overlays/counters, not alternative datasets. Use native fetch/SSE, simple SQL, direct Leaflet, small accessible primitives, and per-role bounded DTOs. Share booking logic between new confirmations and replacements, not parallel implementations.

These choices trade general-purpose distributed infrastructure for explicit small invariants. No production-scale throughput, automatic checkpoint migration, real route/navigation accuracy, payment security, visa/safety advice, or authentic travel availability is claimed.

## 6. Integration Traps Already Closed in the Specification

- Resume carries a trusted GraphResumeEnvelope so new confirmation effects do not use the checkpoint's old operation ID.
- Failed unfinished work blocks ordinary input; technical retry keeps the same operation/revision/scope and grants an explicit bounded recovery round without resetting total/AI/planning counters.
- Saver writes share a fence gate with token rotation; a non-locking ownership read and separate pool avoid claim/guard lock-order or self-starvation cycles.
- Proposed state lives in proposals; confirmed rows are never inserted beside another active row before superseding it; reference collisions use savepoints and exactly3 attempts.
- Initial inventory is flight-only; ensureDomains persists one extension before parallel research; availability overlays enter quote fingerprints independently of unchanged inventories.
- One-night welcome choice is provisional until its own StageB is known, avoiding a variant-selection/validation circular dependency.
- Dinner null requires deterministic no-slot evidence; fixed confirmed meal times/durations do not expand merely because pace changed.
- Ordinary session renewal keeps cookie identity/stable derived CSRF, preventing concurrent tabs from revoking their own trip access.
- Source phases build a real flight graph prefix and then serial service flow before real parallel work; a test-only harness is never presented as the travel graph.
- Inspector graph is a registry-derived safe SVG node/edge view with real events, not only a status table; no client/server-boundary graph invocation is introduced.

## 7. Five Remaining Implementation Risks

1. Crash-window correctness:effect, proposal, booking, checkpoint, event and status writes must match the documented replay order under real process/database failure. Require commit-before-checkpoint and accepted-answer-before-checkpoint tests.
2. Lock/pool/fence correctness:driver token rotation and guarded saver writes must be serialized without deadlocks, leaks or stale commits. Test two connections, stale writer and saturated small pools.
3. Time/geography correctness:UTC/IANA/DST, dates/nights, exact transfer buffers, approved pairs and realized travel cap must agree. Test both variants, short-island exception and absent-airport ground case.
4. Selective-state correctness:source hashes, overlay versions, inherited target levels, actual booked terms and approved/draft itinerary versions must remain distinct. Assert IDs/hashes before and after H/I/J plus route changes across restart/END.
5. External contract drift:packages, metadata/tariffs, time-zone rules and licenses can change. Pin/import actual artifacts, validate compatible role schemas/prices, record provenance, and refuse unsupported versions rather than guessing.

## 8. Operational Inputs and Verification Limits

- Default host node was observed as22.22.2; application baseline is24 LTS. Phase01 must select/verify24 before application acceptance; document parsing under22 is not an application-runtime test.
- Actual reference-download timestamps/checksums and license texts are Phase02 outputs; none is fabricated in this plan.
- Live OpenRouter credentials/model endpoints/prices are operator inputs. Missing credentials leave success criterion28 unverified; fixtures cannot close it.
- Tile provider URL is optional public configuration with policy/attribution constraints. No tile failure may prevent planning.
- Local/test secrets, ports and compatible locked image/tool patches are implementation inputs, not unanswered major architecture questions.
- Documentation validation proves internal references/syntax/coverage structure, not runtime feasibility, zero bugs, model quality, or legal advice.

## 9. Proposed Project-memory Update

Do not edit memory as part of this planning task. If the user requests it later, record the authoritative spec entry point, domain/checkpoint authority split, fresh route-approval invariant, and explicit same-operation technical-retry semantics. Record them as design decisions until implementation evidence exists, not as features already running.

## 10. Implementation Gate

Start only [Phase01](phases/phase-01.md), using its complete executor prompt and verification checklist. No phase automatically authorizes the next one. Preserve unrelated changes and ignored brief/plan/memory files. No commit/push or destructive reset is part of this request.

## 11. Planning Validation Evidence

The planning-only checker verified34 Markdown files,12 phases with all14 required sections and stop rules,7 ADRs, all30 success-criterion mappings, all12 mandatory regression IDs,83 feature IDs and94 planned test IDs. It checked256 relative links/anchors, code-fence balance, trailing whitespace/final newlines, and parsed all10 Mermaid diagrams using Mermaid11.12.0 with no structural errors. These counts are documentation coverage, not executed application tests.

The checker/dependencies live only under `/tmp/kilo/odft-plan-validation`, outside the repository. `git diff --check` passed; existing ignore rules still ignore the root plan/brief/memory. No application files, root package manifest, database migrations, tests, CI, secrets, or git commits were created by this planning task.
