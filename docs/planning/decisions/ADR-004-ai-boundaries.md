# ADR-004: Four Structured AI Roles With No Mutation Authority

Status: accepted for implementation planning; not yet implemented. Date: 2026-10-10.

## Context

Natural-language changes require interpretation and explanation; itinerary ordering benefits from AI. Prices, route practicality, time feasibility, ownership, and reservation commits must remain reproducible and safe. Separate response agents add latency without required decision value.

## Decision

Use independently configurable intent, recommendation, planner, and reviewer profiles behind a provider-independent structured-output adapter. OpenRouter is the initial live provider; deterministic clearly labeled fixtures are the credential-free mode. No separate Response Agent or agent-spawning system exists.

Treat all AI output as untrusted proposals. Validate strict schemas, offered-ID membership, hard constraints, preservation scope, and semantic consistency. Intent cannot emit confirmation/cancellation/approval/simulation operations. Deterministic domain services alone apply commands and book.

Version prompts and capability/pricing profiles. Reserve attempted-call/worst-case cost before transport, retain uncertain billing reservations, record actual/estimated/unknown usage, and reuse successful validated results on replay. Initial limits:40 live attempts/USD1 per trip, two total calls per adapter attempt scope.

Worst cost includes fixed per-request fees and all published tariff overrides, not only base rates. Bound matched endpoints/charges, with gateway prompt/completion/request price filters; unknown additive billing is unsupported.

## Alternatives

| Alternative | Reason not chosen |
| --- | --- |
| One hardcoded LLM for all work | Violates independent role configuration and obscures cost/reasoning tradeoffs |
| Model creates offers/prices/bookings | Unverifiable, unsafe, and nondeterministic |
| Extra response/summarization agents | Outcome templates and deterministic structured summaries suffice |
| Silent live-to-fixture or model fallback | Misrepresents genuine AI and can change semantics/cost |
| Raw reasoning inspection | Not needed for observability and risks disclosure |

## Consequences

- Graph/logging shows role/model/prompt version/tokens/cost/validation, not chain-of-thought.
- Numeric conflicting requests remain typed in a pending clarification without partial mutation.
- Operator supplies actual supported model IDs/endpoints/prices; configuration cannot invent them.
- Live smoke is credential-gated outside ordinary CI but required to verify success criterion28 when configured. Fixture success is not evidence of live model quality.

## Verification and References

[AI design](../06-ai-agent-design.md), [conversation](../07-conversation-and-intents.md), [security](../10-security-reliability.md), [Phase08](../phases/phase-08.md). Test malformed/foreign IDs, injection, contradictory commands, billing-unknown crashes, cap exhaustion, and configured live role outputs.
