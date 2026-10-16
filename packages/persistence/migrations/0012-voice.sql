-- VOICE_CONTROLL.md section 9: durable voice-call ledger. Deliberately separate
-- from `llm_calls` (voice spending never merges into LLM/reasoning totals) and
-- from travel EUR money. Persists ONLY safe accounting metadata: no audio bytes,
-- transcripts, TTS text, provider payloads, keys, headers, or cookies.
--
-- Status machine: reserved -> succeeded | failed | unknown_reserved, and any
-- uncertain charge stays reserved-costed until an explicit operator
-- reconciliation sets `reconciled` with verified billing evidence.

CREATE TABLE IF NOT EXISTS odft_app.voice_calls (
    id                    uuid PRIMARY KEY,
    trip_id               uuid NOT NULL REFERENCES odft_app.trips (id),
    -- Client-supplied idempotency key: one attempt per (trip, request).
    request_id            uuid NOT NULL,
    -- Hash over the immutable request identity (kind/model/input digest); a
    -- reused request id with a different fingerprint is a conflict.
    request_fingerprint   text NOT NULL,
    kind                  text NOT NULL CHECK (kind IN ('stt', 'tts')),
    model                 text NOT NULL,
    gateway               text NOT NULL DEFAULT 'openrouter' CHECK (gateway = 'openrouter'),
    -- Configured restriction target (e.g. the Groq-only guardrail tag).
    provider_restriction  text,
    -- Verified serving provider once observed (never guessed).
    serving_provider      text,
    -- STT has no operation yet; TTS links its actual message AND operation.
    operation_id          uuid REFERENCES odft_app.workflow_operations (id),
    message_id            uuid REFERENCES odft_app.conversation_messages (id),
    pricing_version       text,
    normalization_version text,
    unit_kind             text CHECK (unit_kind IN ('audio_seconds', 'characters')),
    input_units           numeric CHECK (input_units >= 0),
    reserved_cost_usd     numeric(18,9) NOT NULL CHECK (reserved_cost_usd >= 0),
    actual_cost_usd       numeric(18,9) CHECK (actual_cost_usd >= 0),
    latency_ms            integer CHECK (latency_ms >= 0),
    -- Documented X-Generation-Id for server-side reconciliation only.
    generation_id         text,
    error_code            text,
    status                text NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed', 'unknown_reserved', 'reconciled')),
    cost_status           text CHECK (cost_status IN ('actual', 'estimated', 'unknown_reserved')),
    created_at            timestamptz NOT NULL DEFAULT now(),
    settled_at            timestamptz,
    reconciled_at         timestamptz,
    -- A synthesis reservation must link the authoritative message and its
    -- settled operation before any provider call.
    CONSTRAINT voice_calls_tts_links CHECK (
        kind <> 'tts' OR (message_id IS NOT NULL AND operation_id IS NOT NULL)
    ),
    -- Units always travel with their kind so the inspector never fakes tokens.
    CONSTRAINT voice_calls_unit_pair CHECK (
        (unit_kind IS NULL AND input_units IS NULL)
        OR (unit_kind IS NOT NULL AND input_units IS NOT NULL)
    )
);

-- One attempt per request key; duplicate ids reuse the recorded outcome.
CREATE UNIQUE INDEX IF NOT EXISTS voice_calls_trip_request_key
    ON odft_app.voice_calls (trip_id, request_id);

-- Supports the per-trip call-count and USD budget sums under the trip lock.
CREATE INDEX IF NOT EXISTS voice_calls_trip_budget_idx
    ON odft_app.voice_calls (trip_id, created_at);

CREATE INDEX IF NOT EXISTS voice_calls_operation_idx
    ON odft_app.voice_calls (operation_id)
    WHERE operation_id IS NOT NULL;
